// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IKaggleStore` slice (`pgKaggleStore`). Proves it returns the SAME rows
 * as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker
 * container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. List
 * comparisons are scoped to ids inserted by this test, since `SQLiteAdapter.initialize()` seeds
 * defaults into some Kaggle tables.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgKaggleStore } from './kaggle.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { KaggleCompetitionTrackedRow, KaggleRunRow, KaggleCompetitionRubricRow } from '../db-types/kaggle.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

// Some kaggle tables default created_at/updated_at to SQLite's space format, others to ISO-8601 with
// millis (strftime '…T…Z') — both are mirrored faithfully, so accept either shape here.
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+Z?)?$/;

/** Strip clock-dependent columns after asserting each carries the SQLite timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  expect(created_at).toMatch(TS_RE);
  expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-kaggle-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgKaggleStore — IKaggleStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgKaggleStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgKaggleStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── upsert (create) + get parity ──────────────────────────────────────────
  it('upsertKaggleCompetitionTracked + getKaggleCompetitionTracked: identical rows on both stores', async () => {
    const id = randomUUID();
    const row = {
      id,
      tenant_id: `t-${id}`,
      competition_ref: `comp-${id}`,
      title: "O'Brien's \"grand\" challenge ☃",
      category: 'tabular',
      deadline: '2026-12-01',
      reward: '$50,000',
      url: 'https://kaggle.com/c/x',
      status: 'watching',
      notes: 'seed note',
      last_synced_at: null,
    } satisfies Omit<KaggleCompetitionTrackedRow, 'created_at' | 'updated_at'>;

    await sq.upsertKaggleCompetitionTracked(row);
    await pg.upsertKaggleCompetitionTracked!(row);

    const sRow = await sq.getKaggleCompetitionTracked(id);
    const pRow = await pg.getKaggleCompetitionTracked!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
  });

  // ── upsert on-conflict (update) parity ────────────────────────────────────
  it('upsertKaggleCompetitionTracked: ON CONFLICT(tenant_id, competition_ref) updates in place', async () => {
    const tenant = `t-conf-${randomUUID()}`;
    const ref = `comp-conf-${randomUUID()}`;
    const base = {
      id: randomUUID(), tenant_id: tenant, competition_ref: ref, title: 'v1', category: null,
      deadline: null, reward: null, url: null, status: 'watching', notes: null, last_synced_at: null,
    };
    await sq.upsertKaggleCompetitionTracked(base);
    await pg.upsertKaggleCompetitionTracked!(base);

    // Same (tenant, ref), NEW surrogate id — must update the existing row, not insert.
    const conflict = { ...base, id: randomUUID(), title: 'v2', status: 'active' };
    await sq.upsertKaggleCompetitionTracked(conflict);
    await pg.upsertKaggleCompetitionTracked!(conflict);

    const sList = (await sq.listKaggleCompetitionsTracked({ tenantId: tenant }));
    const pList = (await pg.listKaggleCompetitionsTracked!({ tenantId: tenant }));
    expect(pList.length).toBe(1);
    expect(sList.length).toBe(1);
    expect(pList[0]!.title).toBe('v2');
    expect(pList[0]!.status).toBe('active');
    expect(normTs(pList[0]!)).toEqual(normTs(sList[0]!));
  });

  // ── create + get parity for kaggle_runs ───────────────────────────────────
  it('createKaggleRun + getKaggleRun: identical rows, DOUBLE PRECISION score preserved', async () => {
    const id = randomUUID();
    const row = {
      id, tenant_id: null, competition_ref: `comp-run-${id}`, approach_id: null,
      contract_id: null, replay_trace_id: null, mesh_id: null, agent_id: null,
      kernel_ref: null, submission_id: null, public_score: 0.8734,
      validator_report: null, status: 'queued', started_at: null, completed_at: null,
    } satisfies Omit<KaggleRunRow, 'created_at' | 'updated_at'>;

    await sq.createKaggleRun(row);
    await pg.createKaggleRun!(row);

    const sRow = await sq.getKaggleRun(id);
    const pRow = await pg.getKaggleRun!(id);
    expect(pRow).not.toBeNull();
    expect(pRow!.public_score).toBe(0.8734);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
  });

  // ── list parity, scoped to this test's competition_ref ────────────────────
  it('listKaggleRuns: same order (created_at DESC) and same status filtering', async () => {
    const ref = `comp-list-${randomUUID()}`;
    const mk = (status: string) => ({
      id: randomUUID(), tenant_id: null, competition_ref: ref, approach_id: null,
      contract_id: null, replay_trace_id: null, mesh_id: null, agent_id: null,
      kernel_ref: null, submission_id: null, public_score: null,
      validator_report: null, status, started_at: null, completed_at: null,
    });
    for (const s of ['queued', 'running', 'completed']) {
      const r = mk(s);
      await sq.createKaggleRun(r);
      await pg.createKaggleRun!(r);
    }

    const sAll = (await sq.listKaggleRuns({ competitionRef: ref }));
    const pAll = (await pg.listKaggleRuns!({ competitionRef: ref }));
    expect(pAll.map((r) => r.status)).toEqual(sAll.map((r) => r.status));

    const sRunning = (await sq.listKaggleRuns({ competitionRef: ref, status: 'running' }));
    const pRunning = (await pg.listKaggleRuns!({ competitionRef: ref, status: 'running' }));
    expect(pRunning.map((r) => r.id)).toEqual(sRunning.map((r) => r.id));
    expect(pRunning.length).toBe(1);
  });

  // ── update parity, ignores updated_at in the patch ────────────────────────
  it('updateKaggleRun: same mutated row, patch updated_at is ignored', async () => {
    const id = randomUUID();
    const base = {
      id, tenant_id: null, competition_ref: `comp-upd-${id}`, approach_id: null,
      contract_id: null, replay_trace_id: null, mesh_id: null, agent_id: null,
      kernel_ref: null, submission_id: null, public_score: null,
      validator_report: null, status: 'queued', started_at: null, completed_at: null,
    };
    await sq.createKaggleRun(base);
    await pg.createKaggleRun!(base);

    const patch = { status: 'completed', public_score: 0.91, updated_at: 'SHOULD-BE-IGNORED' } as never;
    await sq.updateKaggleRun(id, patch);
    await pg.updateKaggleRun!(id, patch);

    const sRow = await sq.getKaggleRun(id);
    const pRow = await pg.getKaggleRun!(id);
    expect(pRow!.status).toBe('completed');
    expect(pRow!.public_score).toBe(0.91);
    expect(pRow!.updated_at).not.toBe('SHOULD-BE-IGNORED');
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
  });

  // ── upsert returning-row parity (read-then-write path) ────────────────────
  it('upsertKaggleCompetitionRubric: returns the row; second upsert updates by (tenant, ref)', async () => {
    const ref = `comp-rubric-${randomUUID()}`;
    const first = {
      id: randomUUID(), tenant_id: null, competition_ref: ref,
      metric_name: 'auc', metric_direction: 'maximize' as const, baseline_score: 0.5, target_score: 0.9,
      expected_row_count: 1000, id_column: 'id', id_range_min: 1, id_range_max: 1000,
      target_column: 'y', target_type: 'binary', expected_distribution_json: null,
      sample_submission_sha256: null, inference_source: 'auto', auto_generated: 1,
      inferred_at: null, notes: null,
    } satisfies Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>;

    const sCreated = await sq.upsertKaggleCompetitionRubric(first);
    const pCreated = await pg.upsertKaggleCompetitionRubric!(first);
    expect(pCreated.metric_name).toBe('auc');
    expect(pCreated.baseline_score).toBe(0.5);
    expect(normTs(pCreated)).toEqual(normTs(sCreated));

    // Second upsert with the SAME (tenant, ref) but a new surrogate id → updates existing row.
    const second = { ...first, id: randomUUID(), metric_name: 'logloss', metric_direction: 'minimize' as const, target_score: 0.1 };
    const sUpd = await sq.upsertKaggleCompetitionRubric(second);
    const pUpd = await pg.upsertKaggleCompetitionRubric!(second);
    expect(pUpd.metric_name).toBe('logloss');
    // Existing row's id is preserved on update (not the second call's surrogate id).
    expect(pUpd.id).toBe(sUpd.id);
    expect(pUpd.id).toBe(sCreated.id);

    const sList = (await sq.listKaggleCompetitionRubrics({ competitionRef: ref, tenantId: null }));
    const pList = (await pg.listKaggleCompetitionRubrics!({ competitionRef: ref, tenantId: null }));
    expect(pList.length).toBe(1);
    expect(sList.length).toBe(1);
    expect(normTs(pList[0]!)).toEqual(normTs(sList[0]!));
  });

  // ── negative: missing id → null (no throw, no boolean-blind leak) ──────────
  it('negative: missing id returns null on both; injection arg treated as data', async () => {
    expect(await pg.getKaggleRun!('does-not-exist')).toBeNull();
    expect(await sq.getKaggleRun('does-not-exist')).toBeNull();
    expect(await pg.getKaggleCompetitionTracked!(`' OR '1'='1`)).toBeNull();
    expect(await sq.getKaggleCompetitionTracked(`' OR '1'='1`)).toBeNull();
  });
});
