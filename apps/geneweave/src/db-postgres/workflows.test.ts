// SPDX-License-Identifier: MIT
/**
 * Parity tests for the Postgres `IWorkflowStore` domain (db-postgres/workflows.ts): each method must
 * behave identically to the default SQLite adapter, against a REAL Postgres in a throwaway Docker
 * container. Auto-skips when Docker isn't available so `npm test` stays green anywhere. Nothing mocked.
 *
 * The store is built directly from a raw `pg.Pool` via `pgWorkflowStore({ query, now })`, and the full
 * Postgres schema is applied with `POSTGRES_FULL_SCHEMA`, so the test exercises exactly what the app
 * wires up — no adapter plumbing in between.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { pgWorkflowStore } from './workflows.js';
import type { WorkflowDefRow } from '../db-types/workflows.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Project a row onto a fixed column set, normalising undefined→null, so SQLite and Postgres compare cleanly. */
function pick(row: Record<string, unknown>, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] ?? null;
  return out;
}

const DEF_COLS = ['id', 'name', 'description', 'version', 'steps', 'entry_step_id', 'metadata', 'enabled'] as const;

function makeDef(over: Partial<WorkflowDefRow> & Pick<WorkflowDefRow, 'id' | 'name'>): Omit<WorkflowDefRow, 'created_at' | 'updated_at'> {
  return {
    description: null, version: '1.0', steps: '[]', entry_step_id: 'start',
    metadata: null, enabled: 1, ...over,
  };
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-pg-wf-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('IWorkflowStore — Postgres parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgWorkflowStore>;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgWorkflowStore({ query: (t, p) => pool.query(t, p as unknown[]), now: NOW_SQL });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── create / get round-trip ───────────────────────────────────────────────
  it('createWorkflowDef → getWorkflowDef round-trips and stamps timestamps', async () => {
    const id = randomUUID();
    await pg.createWorkflowDef!(makeDef({
      id, name: 'Invoice Pipeline', description: 'process invoices',
      steps: JSON.stringify([{ id: 'start', kind: 'noop' }]), metadata: JSON.stringify({ owner: 'ops' }),
    }));
    const got = (await pg.getWorkflowDef!(id))!;
    expect(got.name).toBe('Invoice Pipeline');
    expect(got.entry_step_id).toBe('start');
    expect(got.enabled).toBe(1);
    expect(got.created_at).toMatch(TS_RE);
    expect(got.updated_at).toMatch(TS_RE);
  });

  // ── missing → null (negative) ─────────────────────────────────────────────
  it('getWorkflowDef returns null for a missing id', async () => {
    expect(await pg.getWorkflowDef!('does-not-exist')).toBeNull();
  });

  // ── update ────────────────────────────────────────────────────────────────
  it('updateWorkflowDef patches only supplied fields', async () => {
    const id = randomUUID();
    await pg.createWorkflowDef!(makeDef({ id, name: 'Before', enabled: 1 }));
    await pg.updateWorkflowDef!(id, { name: 'After', enabled: 0 });
    const got = (await pg.getWorkflowDef!(id))!;
    expect(got.name).toBe('After');
    expect(got.enabled).toBe(0);
    expect(got.entry_step_id).toBe('start'); // untouched
  });

  // ── list ordering parity vs SQLite (byte order, COLLATE "C") ───────────────
  it('parity: listWorkflowDefs orders byte-identically to SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const tag = randomUUID();
      // Mixed case exercises byte-order (uppercase before lowercase), unlike locale order.
      for (const [suffix, name] of [['a', 'zebra'], ['b', 'Apple'], ['c', 'banana']] as const) {
        const def = makeDef({ id: `${tag}-${suffix}`, name });
        await sq.createWorkflowDef(def);
        await pg.createWorkflowDef!(def);
      }
      const sDefs = (await sq.listWorkflowDefs()).filter((d) => d.id.startsWith(tag));
      const pDefs = (await pg.listWorkflowDefs!()).filter((d) => d.id.startsWith(tag));
      expect(pDefs.map((d) => d.name)).toEqual(sDefs.map((d) => d.name));
      expect(pDefs.map((d) => d.name)).toEqual(['Apple', 'banana', 'zebra']); // 'A'(65) < 'b'(98) < 'z'(122)

      // Row-level field parity for a representative def.
      const one = makeDef({ id: `${tag}-x`, name: 'Parity One', description: "O'Brien \"quote\"", steps: JSON.stringify([{ s: 1 }]) });
      await sq.createWorkflowDef(one);
      await pg.createWorkflowDef!(one);
      const sRow = (await sq.getWorkflowDef(`${tag}-x`))!;
      const pRow = (await pg.getWorkflowDef!(`${tag}-x`))!;
      expect(pick(pRow as never, DEF_COLS)).toEqual(pick(sRow as never, DEF_COLS));
    } finally {
      await sq.close();
    }
  });

  // ── triggers: create returns the row + getByKey (representative second domain) ─
  it('createTrigger returns the persisted row and getTriggerByKey finds it', async () => {
    const id = randomUUID();
    const key = `trig-${id}`;
    const created = await pg.createTrigger!({
      id, key, enabled: 1, source_kind: 'contract_emitted', source_config: '{}',
      filter_expr: null, target_kind: 'workflow', target_config: JSON.stringify({ workflowId: 'w1' }),
      input_map: null, rate_limit_per_minute: null, metadata: null,
    });
    expect(created.id).toBe(id);
    expect(created.key).toBe(key);
    expect(created.created_at).toMatch(TS_RE);
    const byKey = (await pg.getTriggerByKey!(key))!;
    expect(byKey.id).toBe(id);
    expect(await pg.getTriggerByKey!('no-such-key')).toBeNull();

    // listTriggers filter parity.
    const filtered = await pg.listTriggers!({ sourceKind: 'contract_emitted' });
    expect(filtered.some((t) => t.id === id)).toBe(true);
  });
});
