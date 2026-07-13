// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — PREFLIGHT gates. Real booted SQLite (for the mutex + unresolved-P1 reads), a manifest with
 * a real key, and injected package/disk probes so each of the five gates is exercised positively and
 * negatively without touching the network or the real filesystem.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { buildManifest, type ManifestBody } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { runPreflight, type PreflightConfig } from './upgrade-preflight.js';
import { tryAcquireUpgradeLock } from './upgrade-lock-store.js';
import { beginUpgradeRun, recordUpgradeDetail } from './upgrade-run-store.js';

const key = generateAttestationSigningKey();
const mkManifest = (edition = 'community', packages: ManifestBody['layers']['packages'] = []) => buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '2.0.0', channel: 'stable', edition,
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {}, layers: { packages, schema: [], content: [] }, artifacts: [],
}, key.privateKey);

describe('Upgrade Engine — preflight gates (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const base = (over: Partial<PreflightConfig> = {}): PreflightConfig => ({
    manifest: mkManifest(), edition: 'community', installedVersion: '1.0.0',
    dbPath: null, // disk gate skipped unless a test opts in
    readInstalledPackageVersion: () => '9.9.9', // everything satisfied by default
    diskFree: async () => 10 * 1024 * 1024 * 1024, // 10 GB free
    ...over,
  });
  const gate = (r: Awaited<ReturnType<typeof runPreflight>>, name: string) => r.gates.find((g) => g.name === name)!;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `preflight-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  it('POSITIVE: all gates pass on a clean instance', async () => {
    const r = await runPreflight(client(), 'sqlite', base());
    expect(r.ok).toBe(true);
    expect(r.gates.map((g) => g.name).sort()).toEqual(['disk', 'edition', 'mutex', 'packages', 'unresolved_p1']);
  });

  it('packages gate: names a stale required package', async () => {
    const r = await runPreflight(client(), 'sqlite', base({
      manifest: mkManifest('community', [{ name: '@weaveintel/realm', version: '0.9.0', requires: '>=0.9.0' }]),
      readInstalledPackageVersion: () => '0.4.0', // below the required range
    }));
    expect(r.ok).toBe(false);
    const g = gate(r, 'packages');
    expect(g.ok).toBe(false);
    expect((g.data as { stale: Array<{ name: string }> }).stale[0]!.name).toBe('@weaveintel/realm');
  });

  it('mutex gate: fails when another operation holds the lock', async () => {
    await tryAcquireUpgradeLock(client(), 'sqlite', 'someone-else');
    const r = await runPreflight(client(), 'sqlite', base());
    expect(gate(r, 'mutex').ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('disk gate: fails when free space is below the minimum; skipped for external DBs', async () => {
    const low = await runPreflight(client(), 'sqlite', base({ dbPath, minFreeBytes: 1e9, diskFree: async () => 1e6 }));
    expect(gate(low, 'disk').ok).toBe(false);
    // dbPath null (Postgres/managed) → the gate is reported OK+skipped, never a false blocker.
    const ext = await runPreflight(client(), 'sqlite', base({ dbPath: null }));
    expect(gate(ext, 'disk')).toMatchObject({ ok: true, data: { skipped: true } });
  });

  it('unresolved_p1 gate: fails when a prior P1 review item is still open', async () => {
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'guardrails', logicalKey: 'g1', disposition: 'diverged', priority: 'P1' });
    const r = await runPreflight(client(), 'sqlite', base());
    expect(gate(r, 'unresolved_p1')).toMatchObject({ ok: false, data: { count: 1 } });
  });

  it('edition gate: fails for a release targeting another edition', async () => {
    const r = await runPreflight(client(), 'sqlite', base({ manifest: mkManifest('enterprise'), edition: 'community' }));
    expect(gate(r, 'edition').ok).toBe(false);
  });
});
