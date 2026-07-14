// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — L2 RELEASE-AWARE code scan. Against a REAL git repo fixture with a BASE tag (v1.0.0), a
 * TARGET tag (v2.0.0), and working-tree edits, so the scan produces genuine three-way classifications —
 * including real `both_changed` conflicts the in-app merge editor can then resolve.
 *
 * Covers baselineAtRef correctness (== the live baseliner) + ignore rules; the full state matrix
 * (both_changed / vendor_updated / operator_modified / added / unchanged); the end-to-end flow (scan →
 * listCodeConflicts → getCodeConflictContent with real content → resolveCodeConflict → cleared); git_required
 * fallbacks; stress (a large tree hashed via cat-file batch within budget); concurrency (parallel resolves of
 * scanned conflicts); and security (hostile ref = argv not shell; ignore set honored).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { generateSourceBaselines } from './source-baselines.js';
import { baselineAtRef, scanCodeAgainstRelease } from './code-release-scan.js';
import { listCodeConflicts, getCodeConflictContent, resolveCodeConflict, loadCodeConflict } from './code-merge.js';

const ID = ['-c', 'user.email=t@t.dev', '-c', 'user.name=Test'];
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (root: string, rel: string, content: string): void => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); };

/**
 * A repo whose src/ has: conflict.ts (changed on BOTH sides differently), vendor.ts (changed only by the
 * release), mine.ts (changed only by the operator), stable.ts (untouched), and added.ts (new in the release).
 * Tags v1.0.0 (BASE) and v2.0.0 (TARGET); the working tree carries the operator's edits.
 */
function makeReleaseRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'relscan-'));
  git(root, ['init', '-q']);
  write(root, 'src/conflict.ts', 'a\nBASE\nc\n');
  write(root, 'src/vendor.ts', 'v-base\n');
  write(root, 'src/mine.ts', 'm-base\n');
  write(root, 'src/stable.ts', 'stable\n');
  git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'base']); git(root, ['tag', 'v1.0.0']);
  // The release (v2.0.0) changes conflict.ts + vendor.ts, and adds added.ts.
  write(root, 'src/conflict.ts', 'a\nRELEASE\nc\n');
  write(root, 'src/vendor.ts', 'v-release\n');
  write(root, 'src/added.ts', 'brand new\n');
  git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'release']); git(root, ['tag', 'v2.0.0']);
  // Back to base, then apply the operator's edits: conflict.ts (differently) + mine.ts.
  git(root, ['checkout', '-q', 'v1.0.0']);
  write(root, 'src/conflict.ts', 'a\nMINE\nc\n');
  write(root, 'src/mine.ts', 'm-edited\n');
  return root;
}

describe('L2 release-aware scan — baselineAtRef (real git)', () => {
  let root: string;
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('POSITIVE: baselineAtRef(ref) equals the live baseliner on a clean checkout of that ref', () => {
    root = makeReleaseRepo();
    git(root, ['stash', '-q', '--include-untracked']); // clean working tree = v1.0.0
    git(root, ['checkout', '-q', 'v2.0.0']);
    const live = generateSourceBaselines(root);
    const atRef = baselineAtRef(root, 'v2.0.0');
    expect(atRef.files).toEqual(live.files);   // same paths + same SRIs
    expect(atRef.digest).toBe(live.digest);
  });

  it('SECURITY: the ignore set is honored — a node_modules file at the ref is never baselined', () => {
    root = mkdtempSync(join(tmpdir(), 'relscan-'));
    git(root, ['init', '-q']);
    write(root, 'src/a.ts', 'x\n');
    write(root, 'node_modules/pkg/index.js', 'vendor junk\n');
    git(root, ['add', '-A', '-f']); git(root, [...ID, 'commit', '-q', '-m', 'c']); git(root, ['tag', 'v1']);
    const b = baselineAtRef(root, 'v1');
    expect(Object.keys(b.files)).toEqual(['src/a.ts']); // node_modules excluded
  });

  it('SECURITY: a hostile ref is argv, not shell — no injection, throws rather than executes', () => {
    root = makeReleaseRepo();
    expect(() => baselineAtRef(root, 'v1.0.0; rm -rf $HOME')).toThrow(); // git rejects the bad ref
    expect(readFileSync(join(root, 'src/stable.ts'), 'utf8')).toBe('stable\n'); // repo intact
  });

  it('STRESS: hashing a 2000-file tree via cat-file batch is fast', () => {
    root = mkdtempSync(join(tmpdir(), 'relscan-'));
    git(root, ['init', '-q']);
    for (let i = 0; i < 2000; i++) write(root, `src/f${i}.ts`, `export const x${i} = ${i};\n`);
    git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'big']); git(root, ['tag', 'v1']);
    const t0 = performance.now();
    const b = baselineAtRef(root, 'v1');
    const ms = performance.now() - t0;
    expect(Object.keys(b.files)).toHaveLength(2000);
    // eslint-disable-next-line no-console
    console.log(`[release-scan stress] baselined 2000 files at a ref in ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(15_000);
  });
});

describe('L2 release-aware scan — scan + end-to-end resolve (real git + booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let root: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `relscan-db-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    root = makeReleaseRepo();
  });
  afterEach(async () => {
    await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('POSITIVE: the three-way scan classifies every state and records a real both_changed conflict (P1)', async () => {
    const out = await scanCodeAgainstRelease(client(), 'sqlite', root, 'v1.0.0', 'v2.0.0');
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return; // narrows away git_required + no_baseline
    const byState = out.report.summary;
    expect(byState['both_changed']).toBe(1);     // conflict.ts
    expect(byState['vendor_updated']).toBe(1);   // vendor.ts
    expect(byState['operator_modified']).toBe(1);// mine.ts
    expect(byState['added']).toBe(1);            // added.ts
    expect(out.report.conflicts).toEqual(['src/conflict.ts']);
    // The conflict is on the review queue as a P1 code item.
    const conflicts = await listCodeConflicts(client(), 'sqlite');
    expect(conflicts.map((c) => c.path)).toEqual(['src/conflict.ts']);
    expect(conflicts[0]!.priority).toBe('P1');
  });

  it('END-TO-END: scan → load real 3-way content → resolve → cleared from the queue', async () => {
    await scanCodeAgainstRelease(client(), 'sqlite', root, 'v1.0.0', 'v2.0.0');
    const conflict = (await listCodeConflicts(client(), 'sqlite'))[0]!;

    // The in-app view loads the REAL three sides + a base-informed pre-merge with markers (MINE vs RELEASE).
    const content = await getCodeConflictContent(client(), 'sqlite', root, conflict.path, { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' });
    expect('status' in content).toBe(false);
    if ('status' in content) return;
    expect(content.base).toBe('a\nBASE\nc\n');
    expect(content.local).toBe('a\nMINE\nc\n');
    expect(content.remote).toBe('a\nRELEASE\nc\n');
    expect(content.clean).toBe(false);
    expect(content.merged).toContain('<<<<<<<');
    expect(content.merged).toContain('MINE');
    expect(content.merged).toContain('RELEASE');

    // The operator resolves it (takes the release line) → written to the working tree + off the queue.
    const res = await resolveCodeConflict(client(), 'sqlite', root, conflict.detailId, conflict.path, 'a\nRELEASE\nc\n');
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'src/conflict.ts'), 'utf8')).toBe('a\nRELEASE\nc\n');
    expect(await listCodeConflicts(client(), 'sqlite')).toHaveLength(0);
  });

  it('NEGATIVE / git_required: non-git root and missing refs degrade gracefully', async () => {
    const notGit = mkdtempSync(join(tmpdir(), 'notgit-'));
    try {
      expect(await scanCodeAgainstRelease(client(), 'sqlite', notGit, 'v1.0.0', 'v2.0.0')).toMatchObject({ status: 'git_required' });
    } finally { rmSync(notGit, { recursive: true, force: true }); }
    expect(await scanCodeAgainstRelease(client(), 'sqlite', root, 'v1.0.0', 'v9.9.9')).toMatchObject({ status: 'git_required' });
  });

  it('CONCURRENCY: after a scan, 100 parallel resolves of distinct conflicts each land exactly once', async () => {
    // Extend the fixture with 100 conflicting files, re-tag, and scan.
    git(root, ['checkout', '-q', 'v1.0.0']);
    for (let i = 0; i < 100; i++) write(root, `src/c${i}.ts`, `x\nB${i}\ny\n`);
    git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'base2']); git(root, ['tag', '-f', 'base2']);
    for (let i = 0; i < 100; i++) write(root, `src/c${i}.ts`, `x\nR${i}\ny\n`);
    git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'rel2']); git(root, ['tag', '-f', 'rel2']);
    git(root, ['checkout', '-q', 'base2']);
    for (let i = 0; i < 100; i++) write(root, `src/c${i}.ts`, `x\nM${i}\ny\n`); // operator edits → both_changed
    await scanCodeAgainstRelease(client(), 'sqlite', root, 'base2', 'rel2');
    const conflicts = (await listCodeConflicts(client(), 'sqlite')).filter((c) => c.path.startsWith('src/c'));
    expect(conflicts.length).toBe(100);
    const durations: number[] = [];
    await Promise.all(conflicts.map((c) => async () => {
      const t = performance.now();
      await resolveCodeConflict(client(), 'sqlite', root, c.detailId, c.path, `x\nRESOLVED\ny\n`);
      durations.push(performance.now() - t);
    }).map((f) => f()));
    const remaining = (await listCodeConflicts(client(), 'sqlite')).filter((c) => c.path.startsWith('src/c'));
    expect(remaining).toHaveLength(0);
    const merged = raw().prepare(`SELECT COUNT(*) c FROM upgrade_details WHERE family='code' AND resolution='merged' AND logical_key LIKE 'src/c%'`).get() as { c: number };
    expect(merged.c).toBe(100);
    const p = (q: number) => { const s = [...durations].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] ?? 0; };
    // eslint-disable-next-line no-console
    console.log(`[release-scan concurrency] 100 parallel resolves · p50 ${p(50).toFixed(1)}ms p95 ${p(95).toFixed(1)}ms p99 ${p(99).toFixed(1)}ms`);
  });
});
