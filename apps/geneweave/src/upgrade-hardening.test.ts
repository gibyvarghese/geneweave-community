// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — hardening: chaos + performance coverage for the gaps not already exercised elsewhere.
 *
 * Chaos (things going wrong): a manifest whose signed body was TAMPERED (bad_signature), an EXPIRED manifest,
 * a corrupt artifact (ssri integrity mismatch), and a true concurrent race on the upgrade mutex (exactly one
 * winner). Performance: the migration ledger keeps re-boots cheap (a second ledgered run applies nothing fast),
 * and a registry reconcile of 10k defaults stays within budget.
 *
 * (Downgrade/anti-rollback, untrusted-key, edition-mismatch, out-of-band-edit graceful-degrade, sequential
 * lock contention, and per-stage crash-resume are already covered in upgrade-check/-apply/realm-seed-reconcile
 * tests and are NOT duplicated here.)
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import {
  buildManifest, createEd25519Verifier, computeIntegrity, verifyIntegrity,
  type ReleaseSource, type ManifestBody,
} from '@weaveintel/upgrade';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { checkForUpdate } from './upgrade-check.js';
import { reconcileRealmFamily } from './realm-seed-reconcile.js';
import { tryAcquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock-store.js';
import { runUpgradeMigrations } from './migrations/index.js';
import { REALM_FAMILIES } from './realm-families.js';

const key = generateAttestationSigningKey();
const verifier = createEd25519Verifier([key.publicKey]);
const body = (version: string, over: Partial<ManifestBody> = {}): ManifestBody => ({
  manifestVersion: 1, name: '@geneweave/app', version, channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [] }, artifacts: [], ...over,
});

describe('Upgrade Engine — hardening chaos + perf (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const cfg = (source: ReleaseSource, extra = {}) => ({ source, verifier, edition: 'community', installedVersion: '1.0.0', ...extra });

  beforeEach(async () => {
    dbPath = join(tmpdir(), `harden-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  // ── Chaos: manifest integrity ────────────────────────────────────────────────────────────────────
  it('CHAOS bad_signature: a manifest whose body was tampered after signing is rejected, floor unchanged', async () => {
    // Sign 2.0.0, then mutate the version — the detached signature no longer covers the bytes.
    const signed = buildManifest(body('2.0.0'), key.privateKey);
    const tampered = { ...signed, version: '9.9.9' };
    const source: ReleaseSource = { latest: async () => tampered };
    const r = await checkForUpdate(client(), 'sqlite', cfg(source));
    expect(r).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
    const row = raw().prepare(`SELECT accepted, outcome, reject_reason FROM upgrade_releases WHERE version='9.9.9' LIMIT 1`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ accepted: 0, outcome: 'rejected', reject_reason: 'bad_signature' }); // recorded, never trusted
  });

  it('CHAOS expired: a manifest past its expiresAt is rejected (freeze-attack defense)', async () => {
    const signed = buildManifest(body('2.0.0', { expiresAt: '2020-01-01T00:00:00.000Z' }), key.privateKey);
    const source: ReleaseSource = { latest: async () => signed };
    const r = await checkForUpdate(client(), 'sqlite', cfg(source, { now: () => new Date('2026-07-01T00:00:00.000Z') }));
    expect(r).toMatchObject({ status: 'rejected', reason: 'expired' });
  });

  it('CHAOS corrupt artifact: an ssri integrity digest fails to verify against flipped bytes', () => {
    const bytes = Buffer.from('the-real-release-artifact-payload');
    const integrity = computeIntegrity(bytes);
    expect(verifyIntegrity(bytes, integrity)).toBe(true);                       // pristine → verifies
    const flipped = Buffer.from(bytes); flipped[0] = (flipped[0] ?? 0) ^ 0xff;  // a single corrupted byte
    expect(verifyIntegrity(flipped, integrity)).toBe(false);                    // corruption is caught
    expect(verifyIntegrity(bytes, 'sha512-not-a-real-digest')).toBe(false);     // a bogus digest never passes
  });

  // ── Chaos: concurrency on the mutex ───────────────────────────────────────────────────────────────
  it('CHAOS lock race: 100 concurrent acquirers → EXACTLY ONE wins (no two upgrades run at once)', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => tryAcquireUpgradeLock(client(), 'sqlite', `holder-${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);               // compare-and-set: a single winner under contention
    // A second wave is fully blocked while the winner holds it.
    const blocked = await Promise.all(Array.from({ length: 50 }, (_, i) => tryAcquireUpgradeLock(client(), 'sqlite', `late-${i}`)));
    expect(blocked.filter(Boolean)).toHaveLength(0);
    // The winner releases; the lock is free again.
    const winnerIdx = results.findIndex(Boolean);
    await releaseUpgradeLock(client(), 'sqlite', `holder-${winnerIdx}`);
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'next')).toBe(true);
  });

  // ── Performance ───────────────────────────────────────────────────────────────────────────────────
  it('PERF ledger boot: a second ledgered migration run applies ZERO batches and is fast', async () => {
    // The first boot already ran the full ledger (createDatabaseAdapter). A re-boot must skip every batch.
    const t0 = performance.now();
    const second = runUpgradeMigrations(raw());
    const ms = performance.now() - t0;
    expect(second.applied).toEqual([]);            // nothing re-applied — the ledger keeps re-boots cheap
    expect(second.skipped.length).toBeGreaterThan(100);
    // eslint-disable-next-line no-console
    console.log(`[perf ledger-reboot] ${second.skipped.length} batches skipped in ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(5_000);
  });

  it('PERF reconcile budget: reconciling 10k unchanged defaults is a content-addressed no-op within budget', async () => {
    await db.seedReconcileRealm?.();               // establish baselines
    const spec = REALM_FAMILIES['prompts']!;
    // Publish 10k distinct default records, then reconcile them AGAIN unchanged → must be a fast no-op.
    const defaults = Array.from({ length: 10_000 }, (_, i) => ({ key: `perf-${i}`, name: `Perf ${i}`, description: `d${i}`, template: `t${i}`, category: 'x', variables: '[]', model_compatibility: '[]', execution_defaults: '{}', framework: '' }));
    await reconcileRealmFamily(client(), 'sqlite', spec, defaults, {}); // first pass publishes
    const t0 = performance.now();
    const res = await reconcileRealmFamily(client(), 'sqlite', spec, defaults, {}); // second pass: unchanged
    const ms = performance.now() - t0;
    expect(res.adopted).toEqual([]);               // content-addressed: nothing changed → nothing adopted
    expect(res.review).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[perf reconcile] 10k unchanged defaults reconciled in ${ms.toFixed(0)}ms (${Math.round(10000 / (ms / 1000))}/s)`);
    expect(ms).toBeLessThan(60_000);
  });
});
