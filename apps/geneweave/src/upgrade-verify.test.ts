// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — post-apply VERIFY. Real booted SQLite (its ledger tables + realm family tables exist), a
 * key-signed manifest, and injected package/external probes so every check — readiness, the three derived
 * manifest invariants, and the optional `@upgrade-critical` hook — is exercised positive and negative.
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
import { verifyUpgrade } from './upgrade-verify.js';

const key = generateAttestationSigningKey();
type Layers = Partial<ManifestBody['layers']>;
const mkManifest = (layers: Layers = {}) => buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '2.0.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {}, layers: { packages: [], schema: [], content: [], ...layers }, artifacts: [],
}, key.privateKey);

describe('Upgrade Engine — verify (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const check = (r: Awaited<ReturnType<typeof verifyUpgrade>>, name: string) => r.checks.find((c) => c.name === name);

  beforeEach(async () => {
    dbPath = join(tmpdir(), `verify-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  it('POSITIVE: a clean instance + empty manifest verifies ok (readiness + no invariants to break)', async () => {
    const r = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest() });
    expect(r.ok).toBe(true);
    expect(check(r, 'readiness:db')?.ok).toBe(true);
    expect(check(r, 'readiness:table:schema_migrations')?.ok).toBe(true);
  });

  it('invariant: an unledgered non-deferred schema batch fails; a DEFERRED one is skipped', async () => {
    const layers: Layers = { schema: [
      { batchId: 'm169-upgrade-releases', contentHash: 'h', dependsOn: [], provides: [] }, // ledgered at boot
      { batchId: 'm999-never-applied', contentHash: 'h', dependsOn: [], provides: [] },     // not ledgered
    ] };
    const bad = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(layers) });
    expect(check(bad, 'invariant:schema-batches-ledgered')?.ok).toBe(false);
    expect(check(bad, 'invariant:schema-batches-ledgered')?.message).toContain('m999-never-applied');
    // Deferring the missing batch → the invariant passes (it's deliberately held).
    const ok = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(layers), deferredBatchIds: new Set(['m999-never-applied']) });
    expect(check(ok, 'invariant:schema-batches-ledgered')?.ok).toBe(true);
  });

  it('invariant: an unknown content family fails; a DEFERRED family is skipped', async () => {
    const layers: Layers = { content: [{ family: 'not_a_family', logicalKey: 'x', remoteHash: 'h', releaseNote: 'n' }] };
    const bad = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(layers) });
    expect(check(bad, 'invariant:content-families-present')?.ok).toBe(false);
    const skipped = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(layers), deferredFamilies: new Set(['not_a_family']) });
    expect(check(skipped, 'invariant:content-families-present')?.ok).toBe(true);
  });

  it('invariant: a stale required package fails the packages invariant', async () => {
    const layers: Layers = { packages: [{ name: '@weaveintel/realm', version: '9.0.0', requires: '>=9.0.0' }] };
    const r = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(layers), readInstalledPackageVersion: () => '0.4.0' });
    expect(r.ok).toBe(false);
    expect(check(r, 'invariant:packages-satisfied')?.message).toContain('@weaveintel/realm');
  });

  it('external @upgrade-critical hook: a failing smoke check fails verify; a passing one does not; a throw is caught', async () => {
    const failing = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(), externalChecks: async () => [{ name: 'smoke:login', ok: false, message: 'login broke' }] });
    expect(failing.ok).toBe(false);
    expect(check(failing, 'smoke:login')?.ok).toBe(false);
    const passing = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(), externalChecks: async () => [{ name: 'smoke:login', ok: true }] });
    expect(passing.ok).toBe(true);
    const threw = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest(), externalChecks: async () => { throw new Error('harness down'); } });
    expect(threw.ok).toBe(false);
    expect(check(threw, 'external:@upgrade-critical')?.message).toContain('harness down');
  });

  it('SECURITY: readiness fails (not throws) when a ledger table is missing', async () => {
    raw().exec('DROP TABLE upgrade_details');
    const r = await verifyUpgrade(client(), 'sqlite', { manifest: mkManifest() });
    expect(r.ok).toBe(false);
    expect(check(r, 'readiness:table:upgrade_details')?.ok).toBe(false);
  });
});
