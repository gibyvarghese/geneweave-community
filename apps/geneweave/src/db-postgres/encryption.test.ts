// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IEncryptionStore` slice (`pgEncryptionStore`). Proves it returns the
 * SAME rows as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway
 * Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). This domain's
 * timestamps are caller-supplied INTEGER epoch-millis (not `datetime('now')` text), so they compare
 * byte-for-byte and need no normalisation. List assertions are scoped to ids/tenants this test
 * inserts so a shared container stays deterministic.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgEncryptionStore } from './encryption.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { TenantKekRow } from '../db-types/encryption.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-enc-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgEncryptionStore — IEncryptionStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgEncryptionStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgEncryptionStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── upsert policy + get parity (incl. integer boolean + null pass-through) ──
  it('upsertTenantEncryptionPolicy + getTenantEncryptionPolicy: identical rows on both stores', async () => {
    const tenantId = `t-${randomUUID()}`;
    const policy = {
      tenant_id: tenantId,
      enabled: 1,
      kms_provider_id: 'local',
      kms_config: JSON.stringify({ region: 'eu-west-1' }),
      active_kek_id: `kek-${randomUUID()}`,
      active_dek_id: null,
      active_bik_id: null,
      rotation_schedule: 'manual',
      blind_index_enabled: 0,
      field_policy: JSON.stringify({ 'users.email': true }),
      shred_requested_at: null,
      shred_completed_at: null,
    };
    await sq.upsertTenantEncryptionPolicy(policy);
    await pg.upsertTenantEncryptionPolicy!(policy);

    const sRow = await sq.getTenantEncryptionPolicy(tenantId);
    const pRow = await pg.getTenantEncryptionPolicy!(tenantId);
    expect(pRow).not.toBeNull();
    // created_at/updated_at are integer epoch defaults that differ per store; drop them.
    const { created_at: _sc, updated_at: _su, ...sRest } = sRow!;
    const { created_at: _pc, updated_at: _pu, ...pRest } = pRow!;
    expect(pRest).toEqual(sRest);
    expect(pRow!.enabled).toBe(1); // integer boolean preserved as a number
  });

  // ── KEK insert + list parity (list scoped to this test's tenant) ───────────
  it('insertTenantKek + listTenantKeks + getTenantKekById: identical rows, version-ordered', async () => {
    const tenantId = `t-${randomUUID()}`;
    const keks: TenantKekRow[] = [3, 1, 2].map((version) => ({
      id: `kek-${randomUUID()}`,
      tenant_id: tenantId,
      version,
      status: 'active',
      wrapped: JSON.stringify({ alg: 'AES-256-GCM', v: version }),
      created_at: 1_700_000_000_000 + version,
      rotated_at: null,
      revoked_at: null,
    }));
    for (const k of keks) {
      await sq.insertTenantKek(k);
      await pg.insertTenantKek!(k);
    }

    const sList = await sq.listTenantKeks(tenantId);
    const pList = await pg.listTenantKeks!(tenantId);
    expect(pList).toEqual(sList);
    expect(pList.map((r) => r.version)).toEqual([1, 2, 3]); // ORDER BY version ASC

    const target = keks[0]!;
    expect(await pg.getTenantKekById!(tenantId, target.id)).toEqual(await sq.getTenantKekById(tenantId, target.id));
  });

  // ── updateTenantKekStatus: column-variant UPDATE (rotated_at set) parity ────
  it('updateTenantKekStatus: sets the status-derived timestamp column identically', async () => {
    const tenantId = `t-${randomUUID()}`;
    const kek: TenantKekRow = {
      id: `kek-${randomUUID()}`,
      tenant_id: tenantId,
      version: 1,
      status: 'active',
      wrapped: '{}',
      created_at: 1_700_000_000_000,
      rotated_at: null,
      revoked_at: null,
    };
    await sq.insertTenantKek(kek);
    await pg.insertTenantKek!(kek);

    await sq.updateTenantKekStatus(kek.id, 'rotated', 1_700_000_009_999);
    await pg.updateTenantKekStatus!(kek.id, 'rotated', 1_700_000_009_999);

    const sRow = (await sq.listTenantKeks(tenantId))[0];
    const pRow = (await pg.listTenantKeks!(tenantId))[0];
    expect(pRow).toEqual(sRow);
    expect(pRow!.status).toBe('rotated');
    expect(pRow!.rotated_at).toBe(1_700_000_009_999);
    expect(pRow!.revoked_at).toBeNull();
  });

  // ── deleteAllTenantWrappedMaterial: transaction→sequential, change counts ───
  it('deleteAllTenantWrappedMaterial: same {keks,deks,biks} counts and both stores emptied', async () => {
    const tenantId = `t-${randomUUID()}`;
    await sq.insertTenantKek({ id: `kek-${randomUUID()}`, tenant_id: tenantId, version: 1, status: 'active', wrapped: '{}', created_at: 1, rotated_at: null, revoked_at: null });
    await pg.insertTenantKek!({ id: `kek-${randomUUID()}`, tenant_id: tenantId, version: 1, status: 'active', wrapped: '{}', created_at: 1, rotated_at: null, revoked_at: null });
    await sq.insertTenantDek({ id: `dek-${randomUUID()}`, tenant_id: tenantId, kek_id: 'k', epoch: 1, status: 'active', wrapped: '{}', created_at: 1, rotated_at: null, revoked_at: null });
    await pg.insertTenantDek!({ id: `dek-${randomUUID()}`, tenant_id: tenantId, kek_id: 'k', epoch: 1, status: 'active', wrapped: '{}', created_at: 1, rotated_at: null, revoked_at: null });
    await sq.insertTenantBik({ id: `bik-${randomUUID()}`, tenant_id: tenantId, epoch: 1, status: 'active', wrapped: '{}', created_at: 1, revoked_at: null, kek_id: 'k' });
    await pg.insertTenantBik!({ id: `bik-${randomUUID()}`, tenant_id: tenantId, epoch: 1, status: 'active', wrapped: '{}', created_at: 1, revoked_at: null, kek_id: 'k' });

    const sCounts = await sq.deleteAllTenantWrappedMaterial(tenantId);
    const pCounts = await pg.deleteAllTenantWrappedMaterial!(tenantId);
    expect(pCounts).toEqual(sCounts);
    expect(pCounts).toEqual({ keks: 1, deks: 1, biks: 1 });
    expect(await pg.listTenantKeks!(tenantId)).toEqual([]);
  });

  // ── boolean-returning affected-row parity (RETURNING vs .changes) ──────────
  it('cancelTenantDeletionRequest: true only when a pending row is cancelled, false otherwise', async () => {
    const id = `del-${randomUUID()}`;
    const req = { id, tenant_id: `t-${randomUUID()}`, requested_at: 1_700_000_000_000, retention_until: 1_700_000_100_000, requested_by: 'op', status: 'pending' as const, reason: null };
    await sq.createTenantDeletionRequest(req);
    await pg.createTenantDeletionRequest!(req);

    expect(await pg.cancelTenantDeletionRequest!(id, 1_700_000_050_000)).toBe(await sq.cancelTenantDeletionRequest(id, 1_700_000_050_000));
    expect(await pg.getTenantDeletionRequest!(id)).toEqual(await sq.getTenantDeletionRequest(id));
    // Second cancel: no longer pending → both return false.
    expect(await pg.cancelTenantDeletionRequest!(id, 1_700_000_060_000)).toBe(false);
    expect(await sq.cancelTenantDeletionRequest(id, 1_700_000_060_000)).toBe(false);
  });

  // ── negative: missing id → null on both (no throw, injection arg is data) ──
  it('negative: lookups for a missing id return null on both stores', async () => {
    expect(await pg.getTenantEncryptionPolicy!('does-not-exist')).toBeNull();
    expect(await sq.getTenantEncryptionPolicy('does-not-exist')).toBeNull();
    expect(await pg.getTenantDeletionRequest!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await pg.getBreakGlassRequest!('nope')).toBeNull();
  });
});
