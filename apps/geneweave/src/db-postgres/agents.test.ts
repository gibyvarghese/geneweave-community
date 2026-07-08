// SPDX-License-Identifier: MIT
/**
 * Parity tests for the Postgres `IAgentStore` slice (`pgAgentStore`). Proves the Postgres domain
 * store returns the same rows the default SQLite adapter does for the same operations, against a
 * REAL Postgres spun up in a throwaway Docker container. Docker-gated: auto-skips when Docker is
 * unavailable so `npm test` stays green anywhere. Nothing is mocked.
 *
 * Harness (per the domain-store contract): raw `pool.query(POSTGRES_FULL_SCHEMA)` builds the schema,
 * then `pgAgentStore({ query, now })` is the store under test. created_at/updated_at are clock-driven
 * and so are asserted by regex rather than equality; the rest of every row is compared field-by-field.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { pgAgentStore } from './agents.js';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import type { IAgentStore } from '../db-types/adapter-agents.js';
import type { WorkerAgentRow, SupervisorAgentRow } from '../db-types/agents.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Compare two rows on a fixed column set, normalising undefined→null; timestamps checked separately. */
const TIMESTAMP_COLS = new Set(['created_at', 'updated_at']);
function assertRowParity(pgRow: Record<string, unknown>, sqRow: Record<string, unknown>, cols: readonly string[]): void {
  for (const c of cols) {
    if (TIMESTAMP_COLS.has(c)) {
      expect(String(pgRow[c])).toMatch(TS_RE);
      expect(String(sqRow[c])).toMatch(TS_RE);
      continue;
    }
    expect(pgRow[c] ?? null).toEqual(sqRow[c] ?? null);
  }
}

const WORKER_COLS: readonly (keyof WorkerAgentRow)[] = [
  'id', 'name', 'display_name', 'job_profile', 'description', 'system_prompt', 'tool_names', 'persona',
  'trigger_patterns', 'task_contract_id', 'max_retries', 'priority', 'category', 'enabled', 'created_at', 'updated_at',
];
const SUPER_COLS: readonly (keyof SupervisorAgentRow)[] = [
  'id', 'tenant_id', 'category', 'name', 'display_name', 'description', 'system_prompt',
  'include_utility_tools', 'default_timezone', 'is_default', 'enabled', 'created_at', 'updated_at',
];

function makeWorker(over: Partial<WorkerAgentRow> & Pick<WorkerAgentRow, 'id' | 'name'>): Omit<WorkerAgentRow, 'created_at' | 'updated_at'> {
  return {
    display_name: null, job_profile: null, description: 'desc', system_prompt: 'sys',
    tool_names: '[]', persona: 'assistant', trigger_patterns: null, task_contract_id: null,
    max_retries: 3, priority: 0, category: 'general', enabled: 1, ...over,
  };
}

function makeSupervisor(over: Partial<SupervisorAgentRow> & Pick<SupervisorAgentRow, 'id' | 'name'>): Omit<SupervisorAgentRow, 'created_at' | 'updated_at'> {
  return {
    tenant_id: null, category: 'general', display_name: null, description: null, system_prompt: null,
    include_utility_tools: 1, default_timezone: null, is_default: 0, enabled: 1, ...over,
  };
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-pg-agents-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgAgentStore — IAgentStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: IAgentStore;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgAgentStore({ query: (t, p) => pool.query(t, p as unknown[]), now: NOW_SQL }) as IAgentStore;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── Worker agents: create + enabled listing parity ────────────────────────
  it('createWorkerAgent / listEnabledWorkerAgents: rows match SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      // Byte-order tiebreak within a priority band + an enabled/disabled + non-general row.
      const rows = [
        makeWorker({ id: `w-${randomUUID()}`, name: 'zebra', priority: 5 }),
        makeWorker({ id: `w-${randomUUID()}`, name: 'Apple', priority: 5 }),
        makeWorker({ id: `w-${randomUUID()}`, name: 'banana', priority: 9 }),
        makeWorker({ id: `w-${randomUUID()}`, name: 'disabled', priority: 9, enabled: 0 }),
        makeWorker({ id: `w-${randomUUID()}`, name: 'other-cat', priority: 9, category: 'hypothesis-validation' }),
      ];
      for (const w of rows) { await sq.createWorkerAgent(w); await pg.createWorkerAgent(w); }

      // SQLite seeds default worker agents at initialize(); scope both lists to THIS test's rows.
      const testIds = new Set(rows.map((r) => r.id));
      const pgList = (await pg.listEnabledWorkerAgents()).filter((r) => testIds.has(r.id));
      const sqList = (await sq.listEnabledWorkerAgents()).filter((r) => testIds.has(r.id));
      // Only enabled + category='general' survive; identical order (priority DESC, byte-order name ASC).
      expect(pgList.map((r) => r.name)).toEqual(sqList.map((r) => r.name));
      expect(pgList.map((r) => r.name)).toEqual(['banana', 'Apple', 'zebra']);
      for (let i = 0; i < pgList.length; i++) assertRowParity(pgList[i]! as never, sqList[i]! as never, WORKER_COLS);
    } finally {
      await sq.close();
    }
  });

  // ── Supervisor agents + tools: multi-table insert parity ──────────────────
  it('createSupervisorAgent (+tools) / getSupervisorAgent / listSupervisorAgents / listAgentTools: match SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const tid = `tenant-${randomUUID()}`;
      const def = makeSupervisor({ id: `s-${randomUUID()}`, name: 'Alpha', tenant_id: tid, is_default: 1 });
      const other = makeSupervisor({ id: `s-${randomUUID()}`, name: 'Beta', tenant_id: tid, category: 'research' });
      const tools = [{ tool_name: 'web_search', allocation: 'required' }, { tool_name: 'datetime' }];

      await sq.createSupervisorAgent(def, tools); await pg.createSupervisorAgent(def, tools);
      await sq.createSupervisorAgent(other); await pg.createSupervisorAgent(other);

      // getSupervisorAgent parity (incl. timestamps present + integer boolean cols).
      assertRowParity((await pg.getSupervisorAgent(def.id))! as never, (await sq.getSupervisorAgent(def.id))! as never, SUPER_COLS);

      // listSupervisorAgents parity — is_default DESC then byte-order name ASC.
      const pgList = (await pg.listSupervisorAgents({ tenantId: tid })).filter((r) => r.id === def.id || r.id === other.id);
      const sqList = (await sq.listSupervisorAgents({ tenantId: tid })).filter((r) => r.id === def.id || r.id === other.id);
      expect(pgList.map((r) => r.name)).toEqual(sqList.map((r) => r.name));
      expect(pgList.map((r) => r.name)).toEqual(['Alpha', 'Beta']); // is_default=1 first

      // Multi-table insert landed: agent_tools rows match, ordered by tool_name.
      const pgTools = await pg.listAgentTools(def.id);
      const sqTools = await sq.listAgentTools(def.id);
      expect(pgTools).toEqual(sqTools);
      expect(pgTools).toEqual([
        { agent_id: def.id, tool_name: 'datetime', allocation: 'default' },
        { agent_id: def.id, tool_name: 'web_search', allocation: 'required' },
      ]);
    } finally {
      await sq.close();
    }
  });

  // ── resolveSupervisorAgent: precedence ladder parity ──────────────────────
  it('resolveSupervisorAgent: tenant+category match resolves identically to SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const tid = `tenant-${randomUUID()}`;
      const agent = makeSupervisor({ id: `s-${randomUUID()}`, name: 'Resolver', tenant_id: tid, category: 'general' });
      const tools = [{ tool_name: 'calc', allocation: 'optional' }];
      await sq.createSupervisorAgent(agent, tools); await pg.createSupervisorAgent(agent, tools);

      const pgRes = await pg.resolveSupervisorAgent({ tenantId: tid, category: 'general' });
      const sqRes = await sq.resolveSupervisorAgent({ tenantId: tid, category: 'general' });
      expect(pgRes).not.toBeNull();
      assertRowParity(pgRes!.agent as never, sqRes!.agent as never, SUPER_COLS);
      expect(pgRes!.tools).toEqual(sqRes!.tools);
      expect(pgRes!.tools).toEqual([{ agent_id: agent.id, tool_name: 'calc', allocation: 'optional' }]);
    } finally {
      await sq.close();
    }
  });

  // ── Negative: missing lookups return null on Postgres, matching SQLite ─────
  it('negative: missing agent lookups return null (no throw)', async () => {
    expect(await pg.getWorkerAgent(`missing-${randomUUID()}`)).toBeNull();
    expect(await pg.getSupervisorAgent(`missing-${randomUUID()}`)).toBeNull();
    // (resolveSupervisorAgent is a resolution with a fallback ladder, not a plain lookup — its parity
    //  is covered above with a controlled agent set, so it's intentionally not asserted here.)
    expect(await pg.listAgentTools(`missing-${randomUUID()}`)).toEqual([]);
  });
});
