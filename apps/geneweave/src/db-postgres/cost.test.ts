// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `ICostStore` slice (`pgCostStore`). Proves it returns the SAME rows as a
 * fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgCostStore } from './cost.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { CostPolicyRow } from '../db-types/cost-governor.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strip clock-dependent columns after asserting each carries the SQLite timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  expect(created_at).toMatch(TS_RE);
  expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-cost-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgCostStore — ICostStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgCostStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgCostStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── create + get parity ───────────────────────────────────────────────────
  it('createCostPolicy + getCostPolicy: identical rows on both stores', async () => {
    const id = randomUUID();
    const policy = {
      id,
      key: `key-${id}`,
      tier: 'performance',
      levers_json: JSON.stringify({ toolSubset: 'intent-rag' }),
      description: "O'Brien's \"balanced\" tier ☃",
      enabled: 1,
    } satisfies Omit<CostPolicyRow, 'created_at' | 'updated_at'>;

    await sq.createCostPolicy(policy);
    await pg.createCostPolicy!(policy);

    const sRow = await sq.getCostPolicy(id);
    const pRow = await pg.getCostPolicy!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer boolean preserved as a number, not coerced to true/false.
    expect(pRow!.enabled).toBe(1);
  });

  // ── list parity, incl. COLLATE "C" byte-order + enabledOnly filter ─────────
  it('listCostPolicies: same order (byte-order sort) and same enabledOnly filtering', async () => {
    const tag = randomUUID().slice(0, 8);
    // Keys chosen so uppercase sorts BEFORE lowercase under COLLATE "C" (byte order), unlike locale.
    const rows = [
      { key: `${tag}-zebra`, enabled: 1 },
      { key: `${tag}-Apple`, enabled: 0 },
      { key: `${tag}-banana`, enabled: 1 },
    ];
    for (const r of rows) {
      const p = { id: randomUUID(), key: r.key, tier: 'balanced', levers_json: null, description: null, enabled: r.enabled };
      await sq.createCostPolicy(p);
      await pg.createCostPolicy!(p);
    }

    const sAll = (await sq.listCostPolicies()).filter((r) => r.key.startsWith(tag));
    const pAll = (await pg.listCostPolicies!()).filter((r) => r.key.startsWith(tag));
    expect(pAll.map((r) => r.key)).toEqual(sAll.map((r) => r.key));
    expect(pAll.map((r) => r.key)).toEqual([`${tag}-Apple`, `${tag}-banana`, `${tag}-zebra`]); // byte order

    const sEnabled = (await sq.listCostPolicies({ enabledOnly: true })).filter((r) => r.key.startsWith(tag));
    const pEnabled = (await pg.listCostPolicies!({ enabledOnly: true })).filter((r) => r.key.startsWith(tag));
    expect(pEnabled.map((r) => r.key)).toEqual(sEnabled.map((r) => r.key));
    expect(pEnabled.map((r) => r.key)).toEqual([`${tag}-banana`, `${tag}-zebra`]); // Apple filtered out
  });

  // ── update parity ─────────────────────────────────────────────────────────
  it('updateCostPolicy: same mutated row, ignores non-allowed fields', async () => {
    const id = randomUUID();
    const base = { id, key: `upd-${id}`, tier: 'economy', levers_json: null, description: 'before', enabled: 1 };
    await sq.createCostPolicy(base);
    await pg.createCostPolicy!(base);

    // `id` is in the disallowed set — must be ignored by both.
    const fields = { tier: 'max', description: 'after', enabled: 0, id: 'HACKED' } as never;
    await sq.updateCostPolicy(id, fields);
    await pg.updateCostPolicy!(id, fields);

    const sRow = await sq.getCostPolicy(id);
    const pRow = await pg.getCostPolicy!(id);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.id).toBe(id); // not "HACKED"
    expect(pRow!.tier).toBe('max');
    expect(pRow!.enabled).toBe(0);
  });

  // ── getCostPolicyByKey parity ─────────────────────────────────────────────
  it('getCostPolicyByKey: identical row via the key lookup', async () => {
    const id = randomUUID();
    const p = { id, key: `bykey-${id}`, tier: 'balanced', levers_json: null, description: null, enabled: 1 };
    await sq.createCostPolicy(p);
    await pg.createCostPolicy!(p);
    expect(normTs((await pg.getCostPolicyByKey!(p.key))!)).toEqual(normTs((await sq.getCostPolicyByKey(p.key))!));
  });

  // ── delete parity ─────────────────────────────────────────────────────────
  it('deleteCostPolicy: removes the row on both stores', async () => {
    const id = randomUUID();
    const p = { id, key: `del-${id}`, tier: 'balanced', levers_json: null, description: null, enabled: 1 };
    await sq.createCostPolicy(p);
    await pg.createCostPolicy!(p);
    await sq.deleteCostPolicy(id);
    await pg.deleteCostPolicy!(id);
    expect(await pg.getCostPolicy!(id)).toBeNull();
    expect(await sq.getCostPolicy(id)).toBeNull();
  });

  // ── negative: missing id → null (no throw, no boolean-blind leak) ──────────
  it('negative: getCostPolicy for a missing id returns null on both', async () => {
    expect(await pg.getCostPolicy!('does-not-exist')).toBeNull();
    expect(await sq.getCostPolicy('does-not-exist')).toBeNull();
    expect(await pg.getCostPolicyByKey!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
  });
});
