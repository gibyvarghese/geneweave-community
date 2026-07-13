// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — APPLY orchestration. Real booted SQLite (full schema + a seed-reconcile so families carry
 * baselines), a real key-signed manifest, real snapshot/restore, and the real strict/ledgered migration
 * runner + registry reconcile. Covers the design's Phase-3 exit criteria: end-to-end apply, both edition
 * policies (merge/locked deferral), crash-resume, snapshot rollback, tenant/customized byte-identity, and
 * item-granular succeeded_with_pending — plus the busy/preflight guards.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { rmSync, readdirSync } from 'node:fs';
import { buildManifest, type ManifestBody } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { snapshotSqliteFile } from './upgrade-snapshot.js';
import { runUpgradeMigrations } from './migrations/index.js';
import { collectRealmSeedDefaults } from './realm-seed-defaults.js';
import { REALM_FAMILIES, logicalKeyOfRow } from './realm-families.js';
import { hashLiveRealmRow } from './realm-seed-reconcile.js';
import { tryAcquireUpgradeLock } from './upgrade-lock-store.js';
import { maintenanceState } from './upgrade-maintenance.js';
import { beginUpgradeRun } from './upgrade-run-store.js';
import { recordUpgradeRelease } from './upgrade-release-store.js';
import { applyUpgrade, computeDeferral, resolveEditionL2Mode, type ApplyContext } from './upgrade-apply.js';

const key = generateAttestationSigningKey();
type Layers = Partial<ManifestBody['layers']>;
function mkManifest(over: { version?: string; edition?: string; layers?: Layers } = {}) {
  const body: ManifestBody = {
    manifestVersion: 1, name: '@geneweave/app', version: over.version ?? '2.0.0', channel: 'stable', edition: over.edition ?? 'community',
    publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
    layers: { packages: [], schema: [], content: [], ...over.layers },
    artifacts: [],
  };
  return buildManifest(body, key.privateKey);
}

describe('Upgrade Engine — apply orchestration (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `apply-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedReconcileRealm?.(); // baseline every family's global rows
  });
  afterEach(async () => {
    await db?.close?.();
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } }
    // Snapshots (apply now retains its snapshot on success) go to a shared temp dir — remove this test's so
    // they don't accumulate and pressure /tmp across the suite.
    try {
      const snapDir = join(tmpdir(), 'weaveintel-upgrade-snapshots');
      for (const f of readdirSync(snapDir)) if (f.startsWith(basename(dbPath))) rmSync(join(snapDir, f), { force: true });
    } catch { /* ignore */ }
  });

  /** A real ApplyContext over the booted adapter: real snapshot, real strict/ledgered runner, real restore. */
  const coreCtx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
    client: () => sqliteSqlClient(raw()),
    dialect: 'sqlite',
    manifest: mkManifest(),
    installedVersion: '1.0.0',
    edition: 'community',
    dbPath,
    defaults: collectRealmSeedDefaults(),
    snapshot: () => snapshotSqliteFile(raw(), dbPath, { label: 'test' }),
    runSchema: async (deferred) => runUpgradeMigrations(raw(), { excludeIds: deferred }),
    // Real restore: SQLite requires close → restore → reopen; the adapter's initialize() reopens + re-pragmas.
    rollback: async (h) => { await db.close(); await h.restore(); await db.initialize(); },
    ...over,
  });
  const runsOf = (status?: string) =>
    raw().prepare(`SELECT * FROM upgrade_runs WHERE mode='apply'${status ? ` AND status='${status}'` : ''}`).all() as Array<Record<string, unknown>>;

  it('unit: edition L2 mode + deferral (merge defers on unresolved code; locked never defers)', () => {
    expect(resolveEditionL2Mode('community')).toBe('merge');
    expect(resolveEditionL2Mode('enterprise')).toBe('locked');
    const m = mkManifest({ layers: { schema: [{ batchId: 'mX', contentHash: 'h', dependsOn: ['src/a.ts'], provides: ['skills'] }] } });
    const merge = computeDeferral(m, ['src/a.ts'], 'merge');
    expect([...merge.deferredBatchIds]).toEqual(['mX']);
    expect([...merge.deferredFamilies]).toEqual(['skills']);
    const locked = computeDeferral(m, ['src/a.ts'], 'locked'); // whole-tree swap — no per-file holds
    expect(locked.deferredBatchIds.size).toBe(0);
    expect(locked.deferredFamilies.size).toBe(0);
  });

  it('POSITIVE: a forced apply runs L3+L4, records a run, and leaves maintenance cleared', async () => {
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(r.status).toBe('succeeded');
    expect(r.runId).toBeTruthy();
    expect(runsOf('succeeded').length).toBe(1);
    expect((await maintenanceState(client(), 'sqlite')).active).toBe(false); // raised then cleared
    // The lock is free again (released in finally).
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'probe')).toBe(true);
  });

  it('BUSY: apply refuses when another operation holds the mutex', async () => {
    await tryAcquireUpgradeLock(client(), 'sqlite', 'someone-else');
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(r.status).toBe('busy');
    expect(runsOf().length).toBe(0); // never opened a run
  });

  it('PREFLIGHT: a wrong-edition release is refused (no force) and no run opens', async () => {
    const r = await applyUpgrade(coreCtx({ manifest: mkManifest({ edition: 'enterprise' }), edition: 'community' }));
    expect(r.status).toBe('preflight_failed');
    expect(r.preflight?.gates.find((g) => g.name === 'edition')?.ok).toBe(false);
    expect(runsOf().length).toBe(0);
  });

  it('RESUME: a crashed running apply run is continued (same runId), not duplicated', async () => {
    const stale = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' }); // left 'running'
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(r.resumed).toBe(true);
    expect(r.runId).toBe(stale);
    expect(runsOf().length).toBe(1); // continued the existing run, no second one
    expect(r.status).toBe('succeeded');
  });

  it('ROLLBACK: an L3 failure restores the snapshot and finishes rolled_back', async () => {
    const r = await applyUpgrade(coreCtx({
      force: true,
      // Write a table then throw — proving the restore reverts a partial L3.
      runSchema: async () => { raw().exec('CREATE TABLE rollback_marker (x INTEGER)'); throw new Error('boom L3'); },
    }));
    expect(r.status).toBe('rolled_back');
    expect(r.error).toContain('boom L3');
    // The marker created before the throw is gone — the snapshot was restored.
    expect(raw().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_marker'`).get()).toBeUndefined();
    expect(runsOf('rolled_back').length).toBe(1);
    expect((await maintenanceState(client(), 'sqlite')).active).toBe(false);
  });

  it('DEFERRAL: merge mode holds a batch whose L2 dep is unresolved; locked mode applies it', async () => {
    const layers: Layers = { schema: [{ batchId: 'mFuture', contentHash: 'h', dependsOn: ['src/x.ts'], provides: ['skills'] }] };
    // Community merge + the code path unresolved → the batch is deferred.
    const merged = await applyUpgrade(coreCtx({ force: true, manifest: mkManifest({ layers }), edition: 'community', unresolvedCodePaths: ['src/x.ts'] }));
    expect(merged.schema?.deferred).toEqual(['mFuture']);
    expect(merged.status).toBe('succeeded_with_pending'); // a deferral is an open review item
    const deferredRows = raw().prepare(`SELECT * FROM upgrade_details WHERE run_id=? AND disposition='deferred'`).all(merged.runId);
    expect(deferredRows.length).toBeGreaterThan(0);
    // Enterprise locked (fresh DB) + same unresolved path → whole-tree swap, nothing deferred.
    await db.close(); rmSync(dbPath, { force: true });
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath }); await db.seedReconcileRealm?.();
    const locked = await applyUpgrade(coreCtx({ force: true, manifest: mkManifest({ layers, edition: 'enterprise' }), edition: 'enterprise', unresolvedCodePaths: ['src/x.ts'] }));
    expect(locked.schema?.deferred).toEqual([]);
  });

  it('PENDING: a diverged content record makes the apply succeeded_with_pending', async () => {
    // Stage a skill the reconcile SHIPS a default for as diverged: base (origin_hash) a sentinel that is
    // neither the live hash (we edited the row) nor the build default → all three differ → diverged.
    const spec = REALM_FAMILIES['skills']!;
    // The reconcile ships built-in skills that have no global row here; clone an existing global row but give
    // it a SHIPPED default's logical key + divergent content + a sentinel baseline → base≠local≠remote = diverged.
    const shipped = collectRealmSeedDefaults()['skills']![0]!;
    const shippedKey = logicalKeyOfRow(spec, shipped as Record<string, unknown>);
    const donor = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    const cols = Object.keys(donor);
    const vals = cols.map((c) =>
      c === 'id' ? 'diverged-skill' : c === 'logical_key' ? shippedKey
        : c === 'description' ? 'operator diverged this' : c === 'origin_hash' ? 'DIVERGED_BASE_SENTINEL' : donor[c]);
    raw().prepare(`INSERT INTO skills (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(r.status).toBe('succeeded_with_pending');
    expect(r.pending).toBeGreaterThan(0);
    const div = raw().prepare(`SELECT * FROM upgrade_details WHERE run_id=? AND family='skills' AND disposition='diverged'`).all(r.runId);
    expect(div.length).toBeGreaterThan(0);
  });

  it('TENANT SAFETY: operator-customized + tenant rows are byte-identical after apply (full-table hash)', async () => {
    const g = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    // (a) Customize a global skill (edit live, KEEP origin_hash) → the reconcile must classify it customized and keep it.
    raw().prepare(`UPDATE skills SET description = 'MY CUSTOM EDIT' WHERE id = ?`).run(g['id']);
    // (b) A tenant-owned copy (invisible to the global reconcile) — clone the row with a new id + realm='tenant'.
    const cols = Object.keys(g);
    const tId = 'tenant-skill-1';
    const vals = cols.map((c) => (c === 'id' ? tId : c === 'realm' ? 'tenant' : c === 'owner_tenant_id' ? 't1' : g[c]));
    raw().prepare(`INSERT INTO skills (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);

    const fullHash = () => JSON.stringify(raw().prepare(`SELECT * FROM skills ORDER BY id`).all());
    const before = fullHash();
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(['succeeded', 'succeeded_with_pending']).toContain(r.status);
    expect(fullHash()).toBe(before); // NOTHING in the skills table changed — customized kept, tenant untouched
  });

  it('RESOLUTION: resolving a P1 detail clears the unresolved-P1 preflight gate (unblocks the next apply)', async () => {
    const { recordUpgradeDetail } = await import('./upgrade-run-store.js');
    const { resolveUpgradeDetail } = await import('./upgrade-run-store.js');
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '1.9.0' });
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'guardrails', logicalKey: 'g1', disposition: 'diverged', priority: 'P1' });
    // A non-forced apply is now blocked by the open P1.
    const blocked = await applyUpgrade(coreCtx());
    expect(blocked.status).toBe('preflight_failed');
    expect(blocked.preflight?.gates.find((g) => g.name === 'unresolved_p1')?.ok).toBe(false);
    // Resolve it → the gate clears and a forced apply proceeds.
    const detail = raw().prepare(`SELECT id FROM upgrade_details WHERE priority='P1' LIMIT 1`).get() as { id: string };
    await resolveUpgradeDetail(client(), 'sqlite', detail.id, { resolution: 'kept', resolvedBy: 'admin-1' });
    const row = raw().prepare(`SELECT resolution, resolved_by FROM upgrade_details WHERE id=?`).get(detail.id) as Record<string, unknown>;
    expect(row).toMatchObject({ resolution: 'kept', resolved_by: 'admin-1' });
    const after = await applyUpgrade(coreCtx());
    expect(after.status === 'succeeded' || after.status === 'succeeded_with_pending').toBe(true);
  });

  it('ADAPTER: db.runUpgradeApply reads the accepted manifest and applies it end-to-end', async () => {
    const m = mkManifest();
    await recordUpgradeRelease(client(), 'sqlite', {
      name: m.name, version: m.version, edition: m.edition, channel: m.channel, publishedAt: m.publishedAt,
      keyFingerprint: m.signature.keyFingerprint, outcome: 'update_available', accepted: true, manifestJson: JSON.stringify(m),
    });
    const r = await db.runUpgradeApply!({ force: true });
    expect('status' in r && r.status).toBe('succeeded');
  });
});
