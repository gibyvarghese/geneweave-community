// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `ILiveAgentsStore` slice (`pgLiveAgentsStore`). Proves it returns the
 * SAME rows as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway
 * Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. List
 * comparisons are scoped to ids this test inserted so a shared container stays deterministic.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgLiveAgentsStore } from './live-agents.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type {
  LiveMeshDefinitionRow,
  LiveAgentDefinitionRow,
  LiveMeshDelegationEdgeRow,
  LiveHandlerKindRow,
  ApiLiveRunRow,
  LiveRunEventRow,
  LiveMeshRow,
  LiveRunRow,
} from '../db-types/live-agents.js';

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

/** Run events carry only `created_at` (append-only, no `updated_at`). */
function normCreatedOnly<T extends { created_at?: string }>(row: T): Omit<T, 'created_at'> {
  const { created_at, ...rest } = row;
  expect(created_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-live-agents-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgLiveAgentsStore — ILiveAgentsStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgLiveAgentsStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgLiveAgentsStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  /** Seed one mesh definition on BOTH stores (FK parent for agent defs / edges). */
  async function seedMeshDef(overrides: Partial<Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>> = {}) {
    const id = overrides.id ?? randomUUID();
    const row = {
      id,
      mesh_key: `mesh-${id}`,
      name: 'Kaggle Mesh',
      charter_prose: "O'Brien's \"balanced\" charter ☃",
      dual_control_required_for: JSON.stringify(['submit_solution']),
      enabled: 1,
      description: null as string | null,
      ...overrides,
    } satisfies Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>;
    const s = await sq.createLiveMeshDefinition(row);
    const p = await pg.createLiveMeshDefinition!(row);
    return { id, row, s, p };
  }

  // ── (1) mesh def create/get + create-returns-row parity ───────────────────
  it('createLiveMeshDefinition + getLiveMeshDefinition: identical rows on both stores', async () => {
    const { id, s, p } = await seedMeshDef();
    // create() returns the freshly-written row on both stores.
    expect(normTs(p)).toEqual(normTs(s));

    const sRow = await sq.getLiveMeshDefinition(id);
    const pRow = await pg.getLiveMeshDefinition!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.enabled).toBe(1); // integer boolean preserved as a number

    // by-key lookup parity
    expect(normTs((await pg.getLiveMeshDefinitionByKey!(sRow!.mesh_key))!)).toEqual(
      normTs((await sq.getLiveMeshDefinitionByKey(sRow!.mesh_key))!),
    );
  });

  // ── (2) list byte-order (COLLATE "C") + enabledOnly filter, scoped to our ids
  it('listLiveMeshDefinitions: same byte-order sort and same enabledOnly filtering', async () => {
    const tag = randomUUID().slice(0, 8);
    // Keys chosen so uppercase sorts BEFORE lowercase under COLLATE "C" (byte order), unlike locale.
    const specs = [
      { mesh_key: `${tag}-zebra`, enabled: 1 },
      { mesh_key: `${tag}-Apple`, enabled: 0 },
      { mesh_key: `${tag}-banana`, enabled: 1 },
    ];
    for (const spec of specs) await seedMeshDef({ mesh_key: spec.mesh_key, enabled: spec.enabled });

    const sAll = (await sq.listLiveMeshDefinitions()).filter((r) => r.mesh_key.startsWith(tag));
    const pAll = (await pg.listLiveMeshDefinitions!()).filter((r) => r.mesh_key.startsWith(tag));
    expect(pAll.map((r) => r.mesh_key)).toEqual(sAll.map((r) => r.mesh_key));
    expect(pAll.map((r) => r.mesh_key)).toEqual([`${tag}-Apple`, `${tag}-banana`, `${tag}-zebra`]); // byte order

    const sEn = (await sq.listLiveMeshDefinitions({ enabledOnly: true })).filter((r) => r.mesh_key.startsWith(tag));
    const pEn = (await pg.listLiveMeshDefinitions!({ enabledOnly: true })).filter((r) => r.mesh_key.startsWith(tag));
    expect(pEn.map((r) => r.mesh_key)).toEqual(sEn.map((r) => r.mesh_key));
    expect(pEn.map((r) => r.mesh_key)).toEqual([`${tag}-banana`, `${tag}-zebra`]); // Apple (disabled) filtered out
  });

  // ── (3) agent definition create (FK parent) + list ordering + update ──────
  it('createLiveAgentDefinition/list/update: FK-parented rows, ordering sort, patch parity', async () => {
    const { id: meshDefId } = await seedMeshDef();

    const mkAgent = (roleKey: string, ordering: number): Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'> => ({
      id: randomUUID(),
      mesh_def_id: meshDefId,
      role_key: roleKey,
      name: `Agent ${roleKey}`,
      role_label: `Role ${roleKey}`,
      persona: 'persona',
      objectives: 'objectives',
      success_indicators: 'wins',
      ordering,
      enabled: 1,
      model_capability_json: JSON.stringify({ task: 'reasoning', toolUse: true }),
      model_routing_policy_key: null,
      model_pinned_id: null,
      default_handler_kind: 'agentic.react',
      default_handler_config_json: '{}',
      default_tool_catalog_keys: JSON.stringify(['web_search']),
      default_attention_policy_key: 'heuristic.inbox-first',
    });

    // Insert out of ordering so the ORDER BY (ordering ASC) actually reorders.
    const a2 = mkAgent('discoverer', 2);
    const a1 = mkAgent('planner', 1);
    for (const a of [a2, a1]) { await sq.createLiveAgentDefinition(a); await pg.createLiveAgentDefinition!(a); }

    const sList = await sq.listLiveAgentDefinitions({ meshDefId });
    const pList = await pg.listLiveAgentDefinitions!({ meshDefId });
    expect(pList.map((r) => r.role_key)).toEqual(sList.map((r) => r.role_key));
    expect(pList.map((r) => r.role_key)).toEqual(['planner', 'discoverer']); // ordering 1, then 2

    // create() returned-row parity + get parity
    expect(normTs((await pg.getLiveAgentDefinition!(a1.id))!)).toEqual(normTs((await sq.getLiveAgentDefinition(a1.id))!));

    // update: dynamic SET patch, undefined ignored, updated_at bumped by ${ctx.now}
    const patch = { role_label: 'Head Planner', enabled: 0, model_pinned_id: undefined } as never;
    await sq.updateLiveAgentDefinition(a1.id, patch);
    await pg.updateLiveAgentDefinition!(a1.id, patch);
    const sUpd = await sq.getLiveAgentDefinition(a1.id);
    const pUpd = await pg.getLiveAgentDefinition!(a1.id);
    expect(normTs(pUpd!)).toEqual(normTs(sUpd!));
    expect(pUpd!.role_label).toBe('Head Planner');
    expect(pUpd!.enabled).toBe(0);
  });

  // ── (4) delegation edge create + delete parity ────────────────────────────
  it('createLiveMeshDelegationEdge + deleteLiveMeshDelegationEdge: parity + removal', async () => {
    const { id: meshDefId } = await seedMeshDef();
    const edge: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'> = {
      id: randomUUID(),
      mesh_def_id: meshDefId,
      from_role_key: 'planner',
      to_role_key: 'discoverer',
      relationship: 'DIRECTS',
      prose: 'planner directs discoverer',
      ordering: 0,
      enabled: 1,
    };
    const s = await sq.createLiveMeshDelegationEdge(edge);
    const p = await pg.createLiveMeshDelegationEdge!(edge);
    expect(normTs(p)).toEqual(normTs(s));

    await sq.deleteLiveMeshDelegationEdge(edge.id);
    await pg.deleteLiveMeshDelegationEdge!(edge.id);
    expect(await pg.getLiveMeshDelegationEdge!(edge.id)).toBeNull();
    expect(await sq.getLiveMeshDelegationEdge(edge.id)).toBeNull();
  });

  // ── (5) handler kind create/get-by-kind parity (no FK) ────────────────────
  it('createLiveHandlerKind + getLiveHandlerKindByKind: identical rows', async () => {
    const row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'> = {
      id: randomUUID(),
      kind: `agentic.react-${randomUUID().slice(0, 6)}`,
      description: 'ReAct loop',
      config_schema_json: JSON.stringify({ type: 'object' }),
      source: 'builtin',
      enabled: 1,
    };
    await sq.createLiveHandlerKind(row);
    await pg.createLiveHandlerKind!(row);
    expect(normTs((await pg.getLiveHandlerKind!(row.id))!)).toEqual(normTs((await sq.getLiveHandlerKind(row.id))!));
    expect(normTs((await pg.getLiveHandlerKindByKind!(row.kind))!)).toEqual(normTs((await sq.getLiveHandlerKindByKind(row.kind))!));
  });

  // ── (6) API live run create/list + append-only run events ordering ────────
  it('createApiLiveRun/listUserApiLiveRuns + appendLiveRunEvent/listLiveRunEvents(afterId): parity', async () => {
    const userId = `user-${randomUUID()}`;
    const run: Omit<ApiLiveRunRow, 'created_at' | 'updated_at'> = {
      id: randomUUID(),
      user_id: userId,
      tenant_id: null,
      agent_id: null,
      status: 'running',
      stop_requested: 0,
      config_json: JSON.stringify({ goal: 'demo' }),
    };
    const sRun = await sq.createApiLiveRun(run);
    const pRun = await pg.createApiLiveRun!(run);
    expect(normTs(pRun)).toEqual(normTs(sRun));
    expect(pRun.stop_requested).toBe(0); // integer boolean is a number

    // list scoped to THIS user id → deterministic on a shared container.
    const sRuns = await sq.listUserApiLiveRuns(userId);
    const pRuns = await pg.listUserApiLiveRuns!(userId);
    expect(pRuns.map((r) => r.id)).toEqual(sRuns.map((r) => r.id));
    expect(pRuns.map((r) => r.id)).toEqual([run.id]);

    // Run events belong to a mesh live_run (live_run_events.run_id → live_runs.id), so build that
    // chain first: mesh definition → provisioned mesh → live run.
    const { id: meshDefId } = await seedMeshDef();
    const meshRow = {
      id: `mesh-${randomUUID()}`, tenant_id: null, mesh_def_id: meshDefId, name: 'run mesh', status: 'ACTIVE',
      domain: null, dual_control_required_for: '[]', owner_human_id: null, mcp_server_ref: null,
      account_id: null, context_json: null,
    } satisfies Omit<LiveMeshRow, 'created_at' | 'updated_at'>;
    await sq.createLiveMesh(meshRow); await pg.createLiveMesh!(meshRow);
    const lrRow = {
      id: `lr-${randomUUID()}`, mesh_id: meshRow.id, tenant_id: null, run_key: `rk-${randomUUID()}`, label: null,
      status: 'RUNNING', stop_requested: 0, started_at: '2026-01-01 00:00:00', completed_at: null, summary: null,
      context_json: null,
    } satisfies Omit<LiveRunRow, 'created_at' | 'updated_at'>;
    await sq.createLiveRun(lrRow); await pg.createLiveRun!(lrRow);
    const lrId = lrRow.id;

    // Append-only events: ids chosen so the byte-order `id ASC` sort is well-defined,
    // and `afterId` (id > $n) skips the first.
    const mkEvent = (id: string, kind: string): Omit<LiveRunEventRow, 'created_at'> => ({
      id, run_id: lrId, step_id: null, kind, agent_id: null, tool_key: null, summary: kind, payload_json: '{}',
    });
    const e1 = mkEvent(`${lrId}-001`, 'tool_call');
    const e2 = mkEvent(`${lrId}-002`, 'handoff');
    for (const e of [e2, e1]) { await sq.appendLiveRunEvent(e); await pg.appendLiveRunEvent!(e); } // insert out of order

    const sEvents = (await sq.listLiveRunEvents({ runId: lrId })).map(normCreatedOnly);
    const pEvents = (await pg.listLiveRunEvents!({ runId: lrId })).map(normCreatedOnly);
    expect(pEvents).toEqual(sEvents);
    expect((await pg.listLiveRunEvents!({ runId: lrId })).map((r) => r.id)).toEqual([e1.id, e2.id]); // id ASC

    const sAfter = await sq.listLiveRunEvents({ runId: lrId, afterId: e1.id });
    const pAfter = await pg.listLiveRunEvents!({ runId: lrId, afterId: e1.id });
    expect(pAfter.map((r) => r.id)).toEqual(sAfter.map((r) => r.id));
    expect(pAfter.map((r) => r.id)).toEqual([e2.id]); // e1 excluded by id > afterId
  });

  // ── (7) negative: missing id → null on both (no throw) ────────────────────
  it('negative: getters for a missing id return null on both stores', async () => {
    expect(await pg.getLiveMeshDefinition!('does-not-exist')).toBeNull();
    expect(await sq.getLiveMeshDefinition('does-not-exist')).toBeNull();
    expect(await pg.getLiveAgentDefinition!('nope')).toBeNull();
    expect(await pg.getApiLiveRun!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getApiLiveRun(`' OR '1'='1`)).toBeNull();
  });
});
