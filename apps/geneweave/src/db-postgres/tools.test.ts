// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IToolStore` slice (`pgToolStore`). Proves it returns the SAME rows as a
 * fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape.
 *
 * NOTE: SQLite seeds default catalog/policy/skill rows on `initialize()`, so every list assertion is
 * scoped to the ids THIS test inserted (tagged with a random suffix), never the full table.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgToolStore } from './tools.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { ToolCatalogRow, ToolPolicyRow, SkillRow, A2ASkillRow } from '../db-types/tools.js';

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
  return new SQLiteAdapter(join(tmpdir(), `gw-tools-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgToolStore — IToolStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgToolStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgToolStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── tool catalog: create + get parity ─────────────────────────────────────
  it('createToolConfig + getToolConfig: identical rows on both stores', async () => {
    const id = randomUUID();
    const t = {
      id,
      name: `tool-${id}`,
      description: "O'Brien's \"web\" fetcher ☃",
      category: 'web',
      risk_level: 'medium',
      requires_approval: 1,
      max_execution_ms: 5000,
      rate_limit_per_min: 30,
      enabled: 1,
      tool_key: `key-${id}`,
      version: '2.0',
      side_effects: 1,
      tags: JSON.stringify(['a', 'b']),
      source: 'builtin',
      credential_id: null,
      allocation_class: 'web',
      config: JSON.stringify({ endpoint: 'https://x' }),
      requires: null,
    } satisfies Omit<ToolCatalogRow, 'created_at' | 'updated_at'>;

    await sq.createToolConfig(t);
    await pg.createToolConfig!(t as unknown as ToolCatalogRow);

    const sRow = await sq.getToolConfig(id);
    const pRow = await pg.getToolConfig!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow! as unknown as ToolCatalogRow)).toEqual(normTs(sRow!));
    // Integer booleans preserved as numbers, not coerced to true/false.
    expect(pRow!.requires_approval).toBe(1);
    expect(pRow!.side_effects).toBe(1);
  });

  // ── getToolCatalogByKey + list byte-order, scoped to this test's ids ───────
  it('getToolCatalogByKey + listToolConfigs: same key lookup and byte-order sort', async () => {
    const tag = randomUUID().slice(0, 8);
    // Same category so the secondary sort (name, byte order) decides ordering.
    const names = [`${tag}-zebra`, `${tag}-Apple`, `${tag}-banana`];
    for (const name of names) {
      const t = {
        id: randomUUID(), name, description: null, category: `zz-${tag}`, risk_level: 'low',
        requires_approval: 0, max_execution_ms: null, rate_limit_per_min: null, enabled: 1,
        tool_key: `tk-${name}`, version: '1.0', side_effects: 0, tags: null, source: 'builtin',
        credential_id: null, allocation_class: null, config: null, requires: null,
      };
      await sq.createToolConfig(t);
      await pg.createToolConfig!(t as unknown as ToolCatalogRow);
    }

    const sAll = (await sq.listToolConfigs()).filter((r) => r.category === `zz-${tag}`);
    const pAll = (await pg.listToolConfigs!()).filter((r) => r.category === `zz-${tag}`);
    expect(pAll.map((r) => r.name)).toEqual(sAll.map((r) => r.name));
    // COLLATE "C": uppercase 'A' (0x41) sorts before lowercase 'b'/'z'.
    expect(pAll.map((r) => r.name)).toEqual([`${tag}-Apple`, `${tag}-banana`, `${tag}-zebra`]);

    const key = `tk-${tag}-banana`;
    expect(normTs((await pg.getToolCatalogByKey!(key))! as unknown as ToolCatalogRow))
      .toEqual(normTs((await sq.getToolCatalogByKey(key))!));
  });

  // ── tool policy: getToolPolicyByKey parity ────────────────────────────────
  it('createToolPolicy + getToolPolicyByKey: identical row via key lookup', async () => {
    const id = randomUUID();
    const p = {
      id, key: `pol-${id}`, name: `policy-${id}`, description: null,
      applies_to: null, applies_to_risk_levels: null, approval_required: 1,
      allowed_risk_levels: JSON.stringify(['low', 'medium']), max_execution_ms: null,
      rate_limit_per_minute: 60, max_concurrent: null, require_dry_run: 0, log_input_output: 1,
      persona_scope: null, active_hours_utc: null, expires_at: null, enabled: 1,
    } satisfies Omit<ToolPolicyRow, 'created_at' | 'updated_at'>;

    await sq.createToolPolicy(p);
    await pg.createToolPolicy!(p as unknown as ToolPolicyRow);

    expect(normTs((await pg.getToolPolicyByKey!(p.key))! as unknown as ToolPolicyRow))
      .toEqual(normTs((await sq.getToolPolicyByKey(p.key))!));
  });

  // ── skills: create + get + enabled-list filter, scoped to this test's ids ──
  it('createSkill + getSkill + listEnabledSkills: identical rows and enabled filtering', async () => {
    const tag = randomUUID().slice(0, 8);
    const mk = (suffix: string, enabled: number, priority: number) => ({
      id: randomUUID(), name: `${tag}-${suffix}`, description: 'd', category: 'c',
      trigger_patterns: JSON.stringify(['t']), instructions: 'do the thing',
      tool_names: null, examples: null, tags: null, priority, version: '1.0',
      tool_policy_key: null, supervisor_agent_id: null, domain_sections: null,
      execution_contract: null, enabled,
    });
    const enabledOne = mk('enabled', 1, 5);
    const disabledOne = mk('disabled', 0, 9);
    for (const s of [enabledOne, disabledOne]) {
      await sq.createSkill(s);
      await pg.createSkill!(s as unknown as SkillRow);
    }

    // get parity for the enabled one
    expect(normTs((await pg.getSkill!(enabledOne.id))! as unknown as SkillRow))
      .toEqual(normTs((await sq.getSkill(enabledOne.id))!));

    // enabled-list filter: only the enabled one shows, scoped to our tag
    const ids = new Set<string>([enabledOne.id, disabledOne.id]);
    const sEnabled = (await sq.listEnabledSkills()).filter((r) => ids.has(r.id));
    const pEnabled = (await pg.listEnabledSkills!()).filter((r) => ids.has(r.id));
    expect(pEnabled.map((r) => r.id)).toEqual(sEnabled.map((r) => r.id));
    expect(pEnabled.map((r) => r.id)).toEqual([enabledOne.id]); // disabled filtered out
  });

  // ── A2A skills: create + get parity ───────────────────────────────────────
  it('createA2ASkill + getA2ASkill: identical row on both stores', async () => {
    const id = `a2a-${randomUUID().slice(0, 8)}`;
    const s = {
      id, name: 'Chat', description: 'converse', tags: JSON.stringify(['x']), examples: null,
      input_modes: null, output_modes: null, security_scopes: JSON.stringify(['a2a:chat']),
      mode: 'agent', required_permission: null, sort_order: 3, enabled: 1,
      agent_tools: null, agent_workers: null,
    } satisfies Omit<A2ASkillRow, 'created_at' | 'updated_at'>;

    await sq.createA2ASkill(s);
    await pg.createA2ASkill!(s as unknown as A2ASkillRow);

    expect(normTs((await pg.getA2ASkill!(id))! as unknown as A2ASkillRow))
      .toEqual(normTs((await sq.getA2ASkill(id))!));
  });

  // ── rate limit: increment semantics match (allow up to limit, then deny) ──
  it('checkAndIncrementRateLimit: same allow/deny sequence + count on both stores', async () => {
    const tool = `rl-${randomUUID().slice(0, 8)}`;
    const scope = 'user:1';
    const win = new Date().toISOString().slice(0, 16); // minute bucket
    // Limit of 2: first two calls allowed, third denied — on both stores.
    const seq = async (adapter: { checkAndIncrementRateLimit(a: string, b: string, c: string, d: number): Promise<boolean> }) =>
      [await adapter.checkAndIncrementRateLimit(tool, scope, win, 2),
       await adapter.checkAndIncrementRateLimit(tool, scope, win, 2),
       await adapter.checkAndIncrementRateLimit(tool, scope, win, 2)];

    const sSeq = await seq(sq);
    const pSeq = await seq(pg as unknown as { checkAndIncrementRateLimit(a: string, b: string, c: string, d: number): Promise<boolean> });
    expect(pSeq).toEqual([true, true, false]);
    expect(pSeq).toEqual(sSeq);
    expect(await pg.getToolRateLimitCount!(tool, scope, win)).toBe(await sq.getToolRateLimitCount(tool, scope, win));
    expect(await pg.getToolRateLimitCount!(tool, scope, win)).toBe(2);
  });

  // ── negative: missing id → null (no throw, no boolean-blind leak) ──────────
  it('negative: lookups for a missing id return null on both stores', async () => {
    expect(await pg.getToolConfig!('does-not-exist')).toBeNull();
    expect(await sq.getToolConfig('does-not-exist')).toBeNull();
    expect(await pg.getSkill!('nope')).toBeNull();
    expect(await pg.getToolPolicyByKey!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
  });
});
