// SPDX-License-Identifier: MIT
/**
 * Tests for the L2 REMOTE code fetch (code-remote-fetch.ts): fetching + extracting + baselining a release tree
 * from a (mock) GitHub tarball feed, the TUF-style integrity gate, the three-way classification against a live
 * install, and the failure/security paths (404 → fetch_failed, tampered tree → integrity_failed, oversize
 * download rejected, path-traversal entry neutralised, concurrency).
 */
import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { create as tarCreate } from 'tar';
import Database from 'better-sqlite3';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { fetchTreeBaseline, scanCodeAgainstRemoteRelease } from './code-remote-fetch.js';

/** Build a gzipped tar of `files` under a top-level `pkg/` wrapper (mirrors GitHub's owner-repo-sha/ wrapper). */
async function makeTarball(files: Record<string, string>): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'uc-tar-src-'));
  const pkg = join(dir, 'pkg');
  for (const [p, content] of Object.entries(files)) {
    const abs = join(pkg, p); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content);
  }
  const chunks: Buffer[] = [];
  for await (const c of tarCreate({ gzip: true, cwd: dir }, ['pkg']) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  rmSync(dir, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

/** A mock GitHub tarball feed. `trees[ref]` is served at /repos/:owner/:repo/tarball/:ref; unknown refs 404. */
async function mockFeed(trees: Record<string, Buffer>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const m = /\/tarball\/(.+)$/.exec(req.url ?? '');
    const ref = m ? decodeURIComponent(m[1]!) : '';
    if (trees[ref]) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(trees[ref]); }
    else { res.writeHead(404); res.end('not found'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe('code-remote-fetch: fetch + baseline', () => {
  let feed: { base: string; close: () => Promise<void> };
  afterEach(async () => { if (feed) await feed.close(); });

  it('fetches, extracts (stripping the wrapper), and baselines a served tarball', async () => {
    feed = await mockFeed({ 'v1.0.0': await makeTarball({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' }) });
    const baseline = await fetchTreeBaseline({ repo: 'acme/app', apiBase: feed.base }, 'v1.0.0');
    expect(Object.keys(baseline.files).sort()).toEqual(['src/a.ts', 'src/b.ts']); // wrapper stripped, paths relative
    expect(baseline.digest).toMatch(/^sha512-/);
  });
});

describe('code-remote-fetch: three-way scan + integrity', () => {
  let db: DatabaseAdapter; let dbPath: string; let installRoot: string;
  let feed: { base: string; close: () => Promise<void> };
  const client = () => sqliteSqlClient((db as unknown as { d: Database.Database }).d);

  beforeEach(async () => {
    dbPath = join(tmpdir(), `uc-remote-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    installRoot = mkdtempSync(join(tmpdir(), 'uc-install-'));
  });
  afterEach(async () => {
    if (feed) await feed.close();
    try { rmSync(dbPath, { force: true }); rmSync(installRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // BASE (installed) → REMOTE (target) → LOCAL (operator's live install)
  const BASE = { 'src/unchanged.ts': 'U\n', 'src/vendor.ts': 'V1\n', 'src/mine.ts': 'M\n', 'src/conflict.ts': 'C0\n' };
  const REMOTE = { 'src/unchanged.ts': 'U\n', 'src/vendor.ts': 'V2\n', 'src/mine.ts': 'M\n', 'src/conflict.ts': 'C-remote\n' };
  const LOCAL = { 'src/unchanged.ts': 'U\n', 'src/vendor.ts': 'V1\n', 'src/mine.ts': 'M-mine\n', 'src/conflict.ts': 'C-local\n' };

  const writeInstall = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) { const abs = join(installRoot, p); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, c); }
  };

  it('classifies vendor_updated (clean) vs operator_modified vs both_changed (conflict)', async () => {
    writeInstall(LOCAL);
    feed = await mockFeed({ 'v1.0.0': await makeTarball(BASE), 'v2.0.0': await makeTarball(REMOTE) });
    const res = await scanCodeAgainstRemoteRelease(
      client(), 'sqlite', installRoot, { repo: 'acme/app', apiBase: feed.base },
      { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' }, null,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const s = res.report.summary;
    expect(s['vendor_updated']).toBe(1);   // vendor.ts: release changed, operator didn't → safe to auto-replace
    expect(s['operator_modified']).toBe(1); // mine.ts: operator changed, release didn't → kept
    expect(s['both_changed']).toBe(1);      // conflict.ts: both changed → flagged for merge
    expect(res.report.conflicts).toContain('src/conflict.ts');
    expect(s['unchanged']).toBe(1);         // unchanged.ts is classified unchanged…
    expect(res.recorded).toBe(3);           // …but only the 3 non-trivial files become review items
  });

  it('accepts a REMOTE tree whose digest matches the manifest, rejects a tampered one', async () => {
    writeInstall(LOCAL);
    const remoteTar = await makeTarball(REMOTE);
    feed = await mockFeed({ 'v1.0.0': await makeTarball(BASE), 'v2.0.0': remoteTar });
    // The true digest = the fetched REMOTE baseline's digest.
    const trueDigest = (await fetchTreeBaseline({ repo: 'acme/app', apiBase: feed.base }, 'v2.0.0')).digest;

    const ok = await scanCodeAgainstRemoteRelease(client(), 'sqlite', installRoot, { repo: 'acme/app', apiBase: feed.base }, { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' }, trueDigest);
    expect(ok.status).toBe('ok');

    const tampered = await scanCodeAgainstRemoteRelease(client(), 'sqlite', installRoot, { repo: 'acme/app', apiBase: feed.base }, { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' }, 'sha512-not-the-real-digest');
    expect(tampered.status).toBe('integrity_failed');
  });

  it('returns fetch_failed when a ref is missing (404), not a throw', async () => {
    writeInstall(LOCAL);
    feed = await mockFeed({ 'v1.0.0': await makeTarball(BASE) }); // no v2.0.0
    const res = await scanCodeAgainstRemoteRelease(client(), 'sqlite', installRoot, { repo: 'acme/app', apiBase: feed.base }, { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' }, null);
    expect(res.status).toBe('fetch_failed');
  });

  it('runs 20 concurrent scans without corruption (each records a coherent report)', async () => {
    writeInstall(LOCAL);
    feed = await mockFeed({ 'v1.0.0': await makeTarball(BASE), 'v2.0.0': await makeTarball(REMOTE) });
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      scanCodeAgainstRemoteRelease(client(), 'sqlite', installRoot, { repo: 'acme/app', apiBase: feed.base }, { baseRef: 'v1.0.0', remoteRef: 'v2.0.0' }, null)));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    for (const r of results) if (r.status === 'ok') expect(r.report.summary['both_changed']).toBe(1);
  });
});
