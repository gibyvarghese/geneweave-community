// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — auto-rollback on verify failure + MANUAL rollback + bounded snapshot retention. Real
 * booted SQLite, real snapshot/restore. Proves the design's Phase-4 exit: a verify failure rolls the apply
 * back unattended (mutations reverted), a successful run's snapshot is retained + reversible on demand, and
 * older snapshots are discarded (retention bounded to one).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { buildManifest, type ManifestBody } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { snapshotSqliteFile } from './upgrade-snapshot.js';
import { runUpgradeMigrations } from './migrations/index.js';
import { collectRealmSeedDefaults } from './realm-seed-defaults.js';
import { getUpgradeRun, beginUpgradeRun } from './upgrade-run-store.js';
import { recordUpgradeRelease } from './upgrade-release-store.js';
import { verifyUpgrade } from './upgrade-verify.js';
import { applyUpgrade, type ApplyContext } from './upgrade-apply.js';

const key = generateAttestationSigningKey();
const mkManifest = () => buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '2.0.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {}, layers: { packages: [], schema: [], content: [] }, artifacts: [],
}, key.privateKey);

describe('Upgrade Engine — verify auto-rollback + manual rollback (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const tableExists = (t: string) => !!raw().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

  beforeEach(async () => {
    dbPath = join(tmpdir(), `rollback-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedReconcileRealm?.();
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** A real ApplyContext with verify + retention wired to real snapshot/restore ops. */
  const coreCtx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
    client: () => sqliteSqlClient(raw()),
    dialect: 'sqlite', manifest: mkManifest(), installedVersion: '1.0.0', edition: 'community', dbPath,
    defaults: collectRealmSeedDefaults(),
    snapshot: () => snapshotSqliteFile(raw(), dbPath, { label: 'test' }),
    runSchema: async (d) => runUpgradeMigrations(raw(), { excludeIds: d }),
    rollback: async (h) => { await db.close(); await h.restore(); await db.initialize(); },
    verify: (deferred) => verifyUpgrade(sqliteSqlClient(raw()), 'sqlite', { manifest: mkManifest(), deferredBatchIds: deferred.batchIds, deferredFamilies: deferred.families }),
    discardSnapshot: async (ref) => { try { rmSync(ref, { force: true }); } catch { /* ignore */ } },
    ...over,
  });

  const storeAccepted = async () => {
    const m = mkManifest();
    await recordUpgradeRelease(client(), 'sqlite', {
      name: m.name, version: m.version, edition: m.edition, channel: m.channel, publishedAt: m.publishedAt,
      keyFingerprint: m.signature.keyFingerprint, outcome: 'update_available', accepted: true, manifestJson: JSON.stringify(m),
    });
  };

  it('AUTO-ROLLBACK: a failing verify reverts the applied mutations, rolled_back + P1 audit', async () => {
    const r = await applyUpgrade(coreCtx({
      force: true,
      // Simulate an L3 that DID change the schema, so we can prove the restore reverted it.
      runSchema: async () => { raw().exec('CREATE TABLE verify_rollback_marker (x INTEGER)'); return { applied: ['mMarker'], skipped: [] }; },
      verify: async () => ({ ok: false, checks: [{ name: 'invariant:test', ok: false, message: 'forced failure' }] }),
    }));
    expect(r.status).toBe('rolled_back');
    expect(r.verify?.ok).toBe(false);
    expect(tableExists('verify_rollback_marker')).toBe(false); // the snapshot restore reverted the L3 change
    expect(getUpgradeRun(client(), 'sqlite', r.runId!)).resolves.toMatchObject({ status: 'rolled_back' });
    const p1 = raw().prepare(`SELECT * FROM upgrade_details WHERE run_id=? AND family='verify' AND priority='P1'`).all(r.runId);
    expect(p1.length).toBe(1);
  });

  it('VERIFY PASS: apply succeeds and RETAINS its snapshot (recorded on the run)', async () => {
    const r = await applyUpgrade(coreCtx({ force: true }));
    expect(r.status).toBe('succeeded');
    expect(r.verify?.ok).toBe(true);
    const run = await getUpgradeRun(client(), 'sqlite', r.runId!);
    expect(run?.snapshot_ref).toBeTruthy();
    expect(existsSync(run!.snapshot_ref!)).toBe(true); // the snapshot file is retained for a future rollback
  });

  it('MANUAL ROLLBACK (adapter): reverts a succeeded run to its retained snapshot', async () => {
    await storeAccepted();
    const applied = await db.runUpgradeApply!({ force: true });
    const runId = 'runId' in applied ? applied.runId! : '';
    expect(runId).toBeTruthy();
    // The upgrade later proves bad — simulate post-apply drift, then roll the run back.
    raw().exec('CREATE TABLE post_apply_change (x INTEGER)');
    const rb = await db.runUpgradeRollback!(runId);
    expect(rb.status).toBe('rolled_back');
    expect(tableExists('post_apply_change')).toBe(false);        // restored to the pre-apply snapshot
    const run = await getUpgradeRun(client(), 'sqlite', runId);
    expect(run).toMatchObject({ status: 'rolled_back', snapshot_ref: null }); // snapshot consumed
  });

  it('RETENTION: a second successful apply discards the prior run’s snapshot (bounded to one)', async () => {
    await storeAccepted();
    const r1 = await db.runUpgradeApply!({ force: true });
    const id1 = 'runId' in r1 ? r1.runId! : '';
    const ref1 = (await getUpgradeRun(client(), 'sqlite', id1))!.snapshot_ref!;
    expect(existsSync(ref1)).toBe(true);
    const r2 = await db.runUpgradeApply!({ force: true });
    const id2 = 'runId' in r2 ? r2.runId! : '';
    // The newest run keeps its snapshot; the older one's is discarded + its ref nulled.
    expect((await getUpgradeRun(client(), 'sqlite', id1))?.snapshot_ref).toBe(null);
    expect((await getUpgradeRun(client(), 'sqlite', id2))?.snapshot_ref).toBeTruthy();
    expect(existsSync(ref1)).toBe(false);
  });

  it('NEGATIVE: rollback of an unknown run → not_found; of a run with no snapshot → no_snapshot', async () => {
    const nf = await db.runUpgradeRollback!('does-not-exist');
    expect(nf.status).toBe('not_found');
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' }); // never snapshotted
    const ns = await db.runUpgradeRollback!(runId);
    expect(ns.status).toBe('no_snapshot');
  });
});
