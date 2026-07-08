// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IRoutingStore` slice (`pgRoutingStore`). Proves it returns the SAME
 * rows as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker
 * container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape.
 *
 * NOTE: `SQLiteAdapter.initialize()` SEEDS default guardrails, task types, capability scores, provider
 * tool adapters and routing policies. The Postgres store starts empty. So every list assertion here is
 * SCOPED to the ids/keys this test inserts — never compared against the full table.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgRoutingStore } from './routing.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { GuardrailRow, RoutingExperimentRow, ModelCapabilityScoreRow } from '../db-types/routing.js';

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
  return new SQLiteAdapter(join(tmpdir(), `gw-routing-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgRoutingStore — IRoutingStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgRoutingStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgRoutingStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── createGuardrail + getGuardrail parity ──────────────────────────────────
  it('createGuardrail + getGuardrail: identical rows on both stores', async () => {
    const id = randomUUID();
    const g = {
      id,
      name: `guard-${id}`,
      description: "O'Brien's \"strict\" PII filter ☃",
      type: 'pii',
      stage: 'input',
      config: JSON.stringify({ mask: true }),
      priority: 50,
      enabled: 1,
      trigger_conditions: null,
      trigger_description: null,
    } satisfies Omit<GuardrailRow, 'created_at' | 'updated_at'>;

    await sq.createGuardrail(g);
    await pg.createGuardrail!(g);

    const sRow = await sq.getGuardrail(id);
    const pRow = await pg.getGuardrail!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer boolean preserved as a number, not coerced to true/false.
    expect(pRow!.enabled).toBe(1);
  });

  // ── listGuardrails: byte-order sort (priority DESC, name COLLATE "C" ASC) ───
  it('listGuardrails: same order for this test\'s rows (priority DESC, byte-order name)', async () => {
    const tag = randomUUID().slice(0, 8);
    // Same priority so the name COLLATE "C" tiebreak decides; uppercase sorts BEFORE lowercase.
    const rows = [`${tag}-zebra`, `${tag}-Apple`, `${tag}-banana`];
    for (const name of rows) {
      const g = {
        id: randomUUID(), name, description: null, type: 'pii', stage: 'input',
        config: null, priority: 7, enabled: 1, trigger_conditions: null, trigger_description: null,
      };
      await sq.createGuardrail(g);
      await pg.createGuardrail!(g);
    }
    const sList = (await sq.listGuardrails()).filter((r) => r.name.startsWith(tag)).map((r) => r.name);
    const pList = (await pg.listGuardrails!()).filter((r) => r.name.startsWith(tag)).map((r) => r.name);
    expect(pList).toEqual(sList);
    expect(pList).toEqual([`${tag}-Apple`, `${tag}-banana`, `${tag}-zebra`]); // byte order
  });

  // ── upsertCapabilityScore: ON CONFLICT DO UPDATE + numeric (non-COLLATE) cols
  it('upsertCapabilityScore: insert then conflicting upsert yields the same mutated row', async () => {
    const id = randomUUID();
    const modelId = `m-${id}`;
    const base = {
      id, tenant_id: `t-${id}`, model_id: modelId, provider: 'anthropic', task_key: 'chat',
      quality_score: 70, supports_tools: 1, supports_streaming: 1, supports_thinking: 0,
      supports_json_mode: 0, supports_vision: 0, max_output_tokens: null,
      benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null,
      production_signal_score: null, signal_sample_count: 0,
    } satisfies Omit<ModelCapabilityScoreRow, 'created_at' | 'updated_at'>;

    await sq.upsertCapabilityScore(base);
    await pg.upsertCapabilityScore!(base);

    // Second upsert on the same (tenant_id, model_id, provider, task_key) unique key → UPDATE branch.
    const bumped = { ...base, id: randomUUID(), quality_score: 88, production_signal_score: 42.5 };
    await sq.upsertCapabilityScore(bumped);
    await pg.upsertCapabilityScore!(bumped);

    const sRow = (await sq.listCapabilityScores({ modelId })).find((r) => r.model_id === modelId)!;
    const pRow = (await pg.listCapabilityScores!({ modelId })).find((r) => r.model_id === modelId)!;
    expect(normTs(pRow)).toEqual(normTs(sRow));
    expect(pRow.quality_score).toBe(88);
    // upsertCapabilityScore's ON CONFLICT SET deliberately does NOT overwrite production_signal_score
    // / signal_sample_count (runtime signals maintained by a separate feedback path) — so after a
    // conflicting benchmark upsert it stays at the original value, identically on both engines.
    expect(pRow.production_signal_score).toBeNull();
    expect(pRow.production_signal_score).toEqual(sRow.production_signal_score);
    // The conflicting insert keeps the ORIGINAL id (excluded set doesn't touch id).
    expect(pRow.id).toBe(id);
  });

  // ── createRoutingExperiment + get + list parity (COLLATE DESC + tenant filter)
  it('createRoutingExperiment + get + list: identical rows and filtered ordering', async () => {
    const tenantId = `t-${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      const r = {
        id, name: `exp-${id}`, description: null, tenant_id: tenantId, task_key: 'chat',
        baseline_provider: 'anthropic', baseline_model_id: 'a', candidate_provider: 'openai',
        candidate_model_id: 'b', traffic_pct: 10, status: 'active', metadata: null,
      } satisfies Omit<RoutingExperimentRow, 'created_at' | 'updated_at' | 'started_at' | 'ended_at'>;
      await sq.createRoutingExperiment(r);
      await pg.createRoutingExperiment!(r);
    }

    const sGet = await sq.getRoutingExperiment(ids[0]!);
    const pGet = await pg.getRoutingExperiment!(ids[0]!);
    expect(pGet).not.toBeNull();
    // started_at/created_at/updated_at are all clock-dependent; strip started_at then normTs the rest.
    const stripStarted = <T extends { started_at?: string }>(row: T) => {
      const { started_at, ...rest } = row;
      expect(started_at).toMatch(TS_RE);
      return rest;
    };
    expect(normTs(stripStarted(pGet!))).toEqual(normTs(stripStarted(sGet!)));

    // tenant filter: `(tenant_id = ? OR tenant_id IS NULL)` — scope to THIS tenant's ids only.
    const sList = (await sq.listRoutingExperiments({ tenantId })).filter((r) => ids.includes(r.id));
    const pList = (await pg.listRoutingExperiments!({ tenantId })).filter((r) => ids.includes(r.id));
    expect(pList.map((r) => r.id)).toEqual(sList.map((r) => r.id));
    expect(pList).toHaveLength(3);
  });

  // ── negative: missing id → null (no throw, injection arg is data not code) ──
  it('negative: missing ids return null on both stores', async () => {
    expect(await pg.getGuardrail!('does-not-exist')).toBeNull();
    expect(await sq.getGuardrail('does-not-exist')).toBeNull();
    expect(await pg.getRoutingExperiment!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getRoutingExperiment(`' OR '1'='1`)).toBeNull();
  });
});
