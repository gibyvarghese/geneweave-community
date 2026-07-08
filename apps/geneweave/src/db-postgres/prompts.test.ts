// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IPromptStore` slice (`pgPromptStore`). Proves it returns the SAME rows
 * as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker
 * container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. List
 * comparisons are scoped to this test's inserted ids so the SQLite adapter's initialize()-seeded
 * default rows don't leak into the assertion.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgPromptStore } from './prompts.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { ModelPricingRow } from '../db-types/routing.js';
import type { PromptRow, PromptVersionRow } from '../db-types/prompts.js';

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
  if (updated_at !== undefined) expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-prompts-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgPromptStore — IPromptStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgPromptStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgPromptStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── create + get parity (model pricing: numbers, integer-boolean, TEXT JSON) ─
  it('createModelPricing + getModelPricing: identical rows on both stores', async () => {
    const id = randomUUID();
    const row = {
      id,
      model_id: `mdl-${id}`,
      provider: 'anthropic',
      display_name: "O'Brien's \"fast\" model ☃",
      input_cost_per_1m: 3.5,
      output_cost_per_1m: 15,
      quality_score: 0.87,
      source: 'manual',
      last_synced_at: null,
      enabled: 1,
    } satisfies Omit<ModelPricingRow, 'created_at' | 'updated_at'>;

    await sq.createModelPricing(row);
    await pg.createModelPricing!(row);

    const sRow = await sq.getModelPricing(id);
    const pRow = await pg.getModelPricing!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer boolean preserved as a number, not coerced. anthropic → prompt cache on by default.
    expect(pRow!.enabled).toBe(1);
    expect(pRow!.prompt_cache_enabled).toBe(1);
  });

  // ── create + get parity (prompt: many nullable columns default to null) ──────
  it('createPrompt + getPrompt: identical rows incl. null defaults', async () => {
    const id = randomUUID();
    const row = {
      id,
      key: `pk-${id}`,
      name: `prompt-${id}`,
      description: null,
      category: null,
      prompt_type: 'system',
      owner: null,
      status: 'draft',
      tags: JSON.stringify(['a', 'b']),
      template: 'Hello {{name}}',
      variables: null,
      version: '1.0.0',
      model_compatibility: null,
      execution_defaults: null,
      framework: null,
      metadata: null,
      is_default: 0,
      enabled: 1,
    } satisfies Omit<PromptRow, 'created_at' | 'updated_at'>;

    await sq.createPrompt(row);
    await pg.createPrompt!(row);

    const sRow = await sq.getPrompt(id);
    const pRow = await pg.getPrompt!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
  });

  // ── list parity, byte-order sort scoped to this test's inserted ids ──────────
  it('listPrompts: same COLLATE "C" byte-order over the ids we inserted', async () => {
    const tag = randomUUID().slice(0, 8);
    // Names chosen so uppercase sorts BEFORE lowercase under byte order, unlike locale collation.
    const names = [`${tag}-zebra`, `${tag}-Apple`, `${tag}-banana`];
    const mk = (name: string) =>
      ({
        id: randomUUID(),
        key: `${name}-key`,
        name,
        description: null,
        category: null,
        prompt_type: 'system',
        owner: null,
        status: 'draft',
        tags: null,
        template: 't',
        variables: null,
        version: '1',
        model_compatibility: null,
        execution_defaults: null,
        framework: null,
        metadata: null,
        is_default: 0,
        enabled: 1,
      }) satisfies Omit<PromptRow, 'created_at' | 'updated_at'>;
    for (const n of names) {
      const p = mk(n);
      await sq.createPrompt(p);
      await pg.createPrompt!(p);
    }

    const sNames = (await sq.listPrompts()).map((r) => r.name).filter((n) => n.startsWith(tag));
    const pNames = (await pg.listPrompts!()).map((r) => r.name).filter((n) => n.startsWith(tag));
    expect(pNames).toEqual(sNames);
    expect(pNames).toEqual([`${tag}-Apple`, `${tag}-banana`, `${tag}-zebra`]); // byte order
  });

  // ── update parity (last-write is_active flip has no bearing here) ────────────
  it('updatePrompt: same mutated row on both stores', async () => {
    const id = randomUUID();
    const base = {
      id,
      key: `upd-${id}`,
      name: `upd-${id}`,
      description: 'before',
      category: null,
      prompt_type: 'system',
      owner: null,
      status: 'draft',
      tags: null,
      template: 't',
      variables: null,
      version: '1',
      model_compatibility: null,
      execution_defaults: null,
      framework: null,
      metadata: null,
      is_default: 0,
      enabled: 1,
    } satisfies Omit<PromptRow, 'created_at' | 'updated_at'>;
    await sq.createPrompt(base);
    await pg.createPrompt!(base);

    const fields = { status: 'published', description: 'after', enabled: 0 };
    await sq.updatePrompt(id, fields);
    await pg.updatePrompt!(id, fields);

    const sRow = await sq.getPrompt(id);
    const pRow = await pg.getPrompt!(id);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.status).toBe('published');
    expect(pRow!.enabled).toBe(0);
  });

  // ── multi-statement parity: createPromptVersion flips sibling is_active off ──
  it('createPromptVersion: activating a new version deactivates its siblings', async () => {
    const promptId = randomUUID();
    const v1 = randomUUID();
    const v2 = randomUUID();
    const mkVer = (id: string, version: string, isActive: number) =>
      ({
        id,
        prompt_id: promptId,
        version,
        status: 'published',
        template: `body-${version}`,
        variables: null,
        model_compatibility: null,
        execution_defaults: null,
        framework: null,
        metadata: null,
        is_active: isActive,
        enabled: 1,
      }) satisfies Omit<PromptVersionRow, 'created_at' | 'updated_at'>;

    // Parent prompt must exist first (prompt_versions.prompt_id → prompts.id FK).
    const parent = {
      id: promptId, key: `pk-${promptId}`, name: `prompt-${promptId}`, description: null, category: null,
      prompt_type: 'system', owner: null, status: 'draft', tags: null, template: 'x', variables: null,
      version: '1.0.0', model_compatibility: null, execution_defaults: null, framework: null,
      metadata: null, is_default: 0, enabled: 1,
    } satisfies Omit<PromptRow, 'created_at' | 'updated_at'>;
    await sq.createPrompt(parent);
    await pg.createPrompt!(parent);

    await sq.createPromptVersion(mkVer(v1, '1', 1));
    await pg.createPromptVersion!(mkVer(v1, '1', 1));
    // Second active version must flip the first back to inactive on both stores.
    await sq.createPromptVersion(mkVer(v2, '2', 1));
    await pg.createPromptVersion!(mkVer(v2, '2', 1));

    const sList = (await sq.listPromptVersions(promptId)).map((r) => [r.id, r.is_active] as const);
    const pList = (await pg.listPromptVersions!(promptId)).map((r) => [r.id, r.is_active] as const);
    // Same order (created_at DESC → id v2 then v1 by insertion) and same active flags.
    expect(new Map(pList as unknown as Iterable<[string, number]>)).toEqual(new Map(sList as unknown as Iterable<[string, number]>));
    expect(new Map(pList as unknown as Iterable<[string, number]>).get(v1)).toBe(0);
    expect(new Map(pList as unknown as Iterable<[string, number]>).get(v2)).toBe(1);
  });

  // ── delete parity ───────────────────────────────────────────────────────────
  it('deletePrompt: removes the row on both stores', async () => {
    const id = randomUUID();
    const p = {
      id,
      key: `del-${id}`,
      name: `del-${id}`,
      description: null,
      category: null,
      prompt_type: 'system',
      owner: null,
      status: 'draft',
      tags: null,
      template: 't',
      variables: null,
      version: '1',
      model_compatibility: null,
      execution_defaults: null,
      framework: null,
      metadata: null,
      is_default: 0,
      enabled: 1,
    } satisfies Omit<PromptRow, 'created_at' | 'updated_at'>;
    await sq.createPrompt(p);
    await pg.createPrompt!(p);
    await sq.deletePrompt(id);
    await pg.deletePrompt!(id);
    expect(await pg.getPrompt!(id)).toBeNull();
    expect(await sq.getPrompt(id)).toBeNull();
  });

  // ── negative: missing id → null on both; injection arg is data, not code ────
  it('negative: getPrompt for a missing id returns null on both', async () => {
    expect(await pg.getPrompt!('does-not-exist')).toBeNull();
    expect(await sq.getPrompt('does-not-exist')).toBeNull();
    expect(await pg.getPromptByKey!(`' OR '1'='1`)).toBeNull();
  });
});
