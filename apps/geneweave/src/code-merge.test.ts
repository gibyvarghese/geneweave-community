// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — L2 in-app code-conflict merge backend. Against a REAL git repo fixture (BASE tag, REMOTE
 * tag, LOCAL working tree) + a booted SQLite adapter for the review-row side.
 *
 * Covers: assembling the three text sides + base-informed pre-merge (clean + conflicting + added-file);
 * listing conflicts from the queue; applying a resolution (write + mark resolved); the graceful git-required
 * fallback; stress (large file); concurrency (parallel resolves converge, no corruption); and security (a
 * resolution still carrying markers is refused; a path escaping the source root is refused; git args are argv,
 * not shell — no injection).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { beginUpgradeRun, recordUpgradeDetail } from './upgrade-run-store.js';
import { loadCodeConflict, resolveCodeConflict, listCodeConflicts, getCodeConflictContent } from './code-merge.js';

const ID = ['-c', 'user.email=t@t.dev', '-c', 'user.name=Test'];
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A git repo where a.ts has a BASE (tag v1.0.0), a REMOTE (tag v2.0.0), and a LOCAL working-tree edit. */
function makeRepo(over: { base: string; remote: string; local: string; path?: string } ): string {
  const root = mkdtempSync(join(tmpdir(), 'codemerge-'));
  const p = over.path ?? 'a.ts';
  git(root, ['init', '-q']);
  writeFileSync(join(root, p), over.base);
  git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'base']); git(root, ['tag', 'v1.0.0']);
  writeFileSync(join(root, p), over.remote);
  git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'remote']); git(root, ['tag', 'v2.0.0']);
  // Leave the working tree carrying the operator's LOCAL edit (checkout base first so LOCAL isn't == REMOTE).
  git(root, ['checkout', '-q', 'v1.0.0']);
  writeFileSync(join(root, p), over.local);
  return root;
}

describe('L2 in-app code merge — content assembly (real git repo)', () => {
  let root: string;
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('POSITIVE clean: non-overlapping local + remote edits merge cleanly with both changes', () => {
    root = makeRepo({
      base:   'line1\nline2\nline3\n',
      local:  'LOCAL1\nline2\nline3\n',   // operator changed line 1
      remote: 'line1\nline2\nREMOTE3\n',  // release changed line 3
    });
    const c = loadCodeConflict(root, 'a.ts', 'v1.0.0', 'v2.0.0');
    expect('status' in c).toBe(false);
    if ('status' in c) return;
    expect(c.base).toBe('line1\nline2\nline3\n');
    expect(c.local).toBe('LOCAL1\nline2\nline3\n');
    expect(c.remote).toBe('line1\nline2\nREMOTE3\n');
    expect(c.clean).toBe(true);
    expect(c.merged).toContain('LOCAL1');
    expect(c.merged).toContain('REMOTE3');
    expect(c.merged).not.toContain('<<<<<<<');
  });

  it('POSITIVE conflict: overlapping edits produce diff3 markers, clean=false', () => {
    root = makeRepo({
      base:   'x\nCOMMON\ny\n',
      local:  'x\nMINE\ny\n',
      remote: 'x\nTHEIRS\ny\n',
    });
    const c = loadCodeConflict(root, 'a.ts', 'v1.0.0', 'v2.0.0');
    if ('status' in c) throw new Error('unexpected git_required');
    expect(c.clean).toBe(false);
    expect(c.merged).toContain('<<<<<<<');
    expect(c.merged).toContain('MINE');
    expect(c.merged).toContain('THEIRS');
  });

  it('POSITIVE added-file: a path absent at BASE is treated as empty base (not an error)', () => {
    root = mkdtempSync(join(tmpdir(), 'codemerge-'));
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'seed.ts'), 'x\n'); git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'base']); git(root, ['tag', 'v1.0.0']);
    writeFileSync(join(root, 'new.ts'), 'added by release\n'); git(root, ['add', '-A']); git(root, [...ID, 'commit', '-q', '-m', 'remote']); git(root, ['tag', 'v2.0.0']);
    git(root, ['checkout', '-q', 'v1.0.0']); // new.ts absent locally + at base
    const c = loadCodeConflict(root, 'new.ts', 'v1.0.0', 'v2.0.0');
    if ('status' in c) throw new Error('unexpected git_required');
    expect(c.base).toBe('');            // absent at base
    expect(c.local).toBe('');           // absent locally
    expect(c.remote).toBe('added by release\n');
    expect(c.clean).toBe(true);
    expect(c.merged).toContain('added by release');
  });

  it('git_required: a non-git directory degrades gracefully (resolve on the branch)', () => {
    root = mkdtempSync(join(tmpdir(), 'notgit-'));
    const c = loadCodeConflict(root, 'a.ts', 'v1.0.0', 'v2.0.0');
    expect(c).toMatchObject({ status: 'git_required' });
  });

  it('SECURITY: a hostile ref/path is argv, never shell — no injection, graceful empty content', () => {
    root = makeRepo({ base: 'x\n', local: 'y\n', remote: 'z\n' });
    // A ref carrying shell metacharacters: git treats it as one (invalid) ref → absent → empty, no command runs.
    const c = loadCodeConflict(root, 'a.ts', 'v1.0.0', 'v2.0.0; rm -rf $HOME');
    if ('status' in c) throw new Error('unexpected git_required');
    expect(c.remote).toBe('');          // the bogus ref yields no content
    expect(existsSync(join(root, 'a.ts'))).toBe(true); // repo intact — nothing deleted
  });

  it('STRESS: a 10k-line file merges within budget', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
    const base = lines.join('\n') + '\n';
    const local = [...lines]; local[0] = 'LOCAL EDIT';
    const remote = [...lines]; remote[9999] = 'REMOTE EDIT';
    root = makeRepo({ base, local: local.join('\n') + '\n', remote: remote.join('\n') + '\n' });
    const t0 = performance.now();
    const c = loadCodeConflict(root, 'a.ts', 'v1.0.0', 'v2.0.0');
    const ms = performance.now() - t0;
    if ('status' in c) throw new Error('unexpected git_required');
    expect(c.clean).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[code-merge stress] 10k-line 3-way merge in ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(10_000);
  });
});

describe('L2 in-app code merge — queue + resolve (real git repo + booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let root: string;
  let runId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `codemerge-db-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' });
    root = makeRepo({ base: 'x\nCOMMON\ny\n', local: 'x\nMINE\ny\n', remote: 'x\nTHEIRS\ny\n' });
  });
  afterEach(async () => {
    await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const addCodeDetail = (path: string, disposition = 'conflict') =>
    recordUpgradeDetail(client(), 'sqlite', runId, { family: 'code', logicalKey: path, disposition: disposition as never, layer: 'L2', priority: (disposition === 'conflict' ? 'P1' : 'P3') as never });
  const detailIdFor = (path: string) => (raw().prepare(`SELECT id FROM upgrade_details WHERE family='code' AND logical_key=? LIMIT 1`).get(path) as { id: string }).id;

  it('LIST: returns only unresolved family=code conflicts (not other dispositions or families)', async () => {
    await addCodeDetail('a.ts', 'conflict');
    await addCodeDetail('b.ts', 'conflict');
    await addCodeDetail('c.ts', 'customized');                                   // code, but not a conflict
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'skills', logicalKey: 's1', disposition: 'diverged' as never, priority: 'P2' as never });
    const conflicts = await listCodeConflicts(client(), 'sqlite');
    expect(conflicts.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(conflicts.every((c) => c.priority === 'P1')).toBe(true);
  });

  it('RESOLVE positive: writes the resolved file + marks the review row resolved (merged)', async () => {
    await addCodeDetail('a.ts');
    const id = detailIdFor('a.ts');
    const res = await resolveCodeConflict(client(), 'sqlite', root, id, 'a.ts', 'x\nRESOLVED\ny\n');
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x\nRESOLVED\ny\n');          // written to the working tree
    const row = raw().prepare(`SELECT resolution FROM upgrade_details WHERE id=?`).get(id) as { resolution: string };
    expect(row.resolution).toBe('merged');
    expect(await listCodeConflicts(client(), 'sqlite')).toHaveLength(0);                // off the queue
  });

  it('SECURITY: a resolution still carrying conflict markers is REFUSED (never clears the L3 gate)', async () => {
    await addCodeDetail('a.ts');
    const id = detailIdFor('a.ts');
    const res = await resolveCodeConflict(client(), 'sqlite', root, id, 'a.ts', 'x\n<<<<<<< mine\nMINE\n=======\nTHEIRS\n>>>>>>> theirs\ny\n');
    expect(res).toMatchObject({ ok: false, reason: 'unresolved_markers' });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x\nMINE\ny\n');              // file untouched
    const row = raw().prepare(`SELECT resolution FROM upgrade_details WHERE id=?`).get(id) as { resolution: string | null };
    expect(row.resolution).toBeNull();                                                  // still unresolved
  });

  it('SECURITY: a path escaping the source root is REFUSED (no write outside the tree)', async () => {
    await addCodeDetail('../../evil.ts');
    const id = detailIdFor('../../evil.ts');
    const res = await resolveCodeConflict(client(), 'sqlite', root, id, '../../evil.ts', 'pwned\n');
    expect(res).toMatchObject({ ok: false, reason: 'path_escapes_root' });
    expect(existsSync(join(root, '..', '..', 'evil.ts'))).toBe(false);                  // nothing written outside root
  });

  it('CONCURRENCY: 100 parallel resolves of DIFFERENT files all land, each resolved exactly once', async () => {
    const N = 100;   // a bounded, realistic ceiling — an upgrade has a finite number of conflicting files
    for (let i = 0; i < N; i++) {
      writeFileSync(join(root, `f${i}.ts`), 'orig\n');
      await addCodeDetail(`f${i}.ts`);
    }
    const durations: number[] = [];
    await Promise.all(Array.from({ length: N }, (_, i) => async () => {
      const t = performance.now();
      await resolveCodeConflict(client(), 'sqlite', root, detailIdFor(`f${i}.ts`), `f${i}.ts`, `resolved ${i}\n`);
      durations.push(performance.now() - t);
    }).map((f) => f()));
    expect(await listCodeConflicts(client(), 'sqlite')).toHaveLength(0);                // all off the queue
    for (let i = 0; i < N; i++) expect(readFileSync(join(root, `f${i}.ts`), 'utf8')).toBe(`resolved ${i}\n`);
    const resolved = raw().prepare(`SELECT COUNT(*) c FROM upgrade_details WHERE family='code' AND resolution='merged'`).get() as { c: number };
    expect(resolved.c).toBe(N);                                                          // each resolved exactly once — no lost update
    const p = (q: number) => { const s = [...durations].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] ?? 0; };
    // eslint-disable-next-line no-console
    console.log(`[code-merge concurrency] ${N} parallel resolves · p50 ${p(50).toFixed(1)}ms p95 ${p(95).toFixed(1)}ms p99 ${p(99).toFixed(1)}ms`);
  });

  it('git_required orchestration: getCodeConflictContent degrades when refs are unavailable, loads with overrides', async () => {
    await addCodeDetail('a.ts');
    // No accepted release → no remoteRef → git_required.
    const none = await getCodeConflictContent(client(), 'sqlite', root, 'a.ts');
    expect(none).toMatchObject({ status: 'git_required' });
    // With explicit refs (what the adapter sources from the manifest/env), it loads the real content.
    const ok = await getCodeConflictContent(client(), 'sqlite', root, 'a.ts', { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' });
    expect('status' in ok).toBe(false);
    if (!('status' in ok)) expect(ok.clean).toBe(false); // MINE vs THEIRS conflict
    // A missing ref is reported distinctly (not a silent empty merge).
    const missing = await getCodeConflictContent(client(), 'sqlite', root, 'a.ts', { baseRef: 'v1.0.0', remoteRef: 'v9.9.9' });
    expect(missing).toMatchObject({ status: 'git_required' });
  });
});
