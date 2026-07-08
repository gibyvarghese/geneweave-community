// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `seedDefaultData` bootstrap seeder (`pgSeedStore`). Runs the seeder
 * against a REAL Postgres (throwaway Docker container) and a fresh `SQLiteAdapter`.
 *
 * `seedDefaultData` calls sibling adapter methods via `this` (e.g. `this.createSkill!(...)`), so it
 * must run through the FULL composed adapter. `pgSeedStore` isn't registered in the domain registry
 * yet, so the test overlays it and invokes `seedDefaultData.call(pg)` — binding `this` to the real
 * composed `createPostgresAdapter(...)` so sibling calls dispatch through the ported domain stores,
 * exactly as production will once the seed store is registered.
 *
 * PARITY SCOPE — the two backends do NOT start from the same baseline: SQLite's `initialize()` runs
 * bootstrap migrations that PRE-SEED skills/worker-agents/model-pricing/semantic-cache, so those
 * seed blocks are gated off (`cnt(...) === 0` is false) on SQLite; the Postgres `POSTGRES_FULL_SCHEMA`
 * baseline is empty, so those blocks run fully. Exact set-equality parity is therefore asserted only
 * for the tables BOTH backends seed from empty (cost_policies, routing_policies,
 * model_capability_scores, tenant_encryption_policy). For the migration-pre-seeded tables we assert
 * the Postgres seed produced the canonical seeded rows (the ported logic ran end-to-end). Idempotency
 * is asserted on Postgres directly.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere).
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { createPostgresAdapter } from '../db.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import { pgSeedStore } from './seed.js';
import { BUILT_IN_SKILLS } from '@weaveintel/skills';
import type { DatabaseAdapter } from '../db-types/adapter.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-seed-parity-${Date.now()}-${randomUUID()}.db`));
}

/** Sorted list of a keyable field across rows — order-independent set comparison. */
function sortedKeys<T>(rows: readonly T[], key: (r: T) => string): string[] {
  return rows.map(key).sort();
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgSeedStore — seedDefaultData parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: DatabaseAdapter;
  let sq: SQLiteAdapter;
  /** Bound seedDefaultData that dispatches sibling `this.*` calls through the composed pg adapter. */
  let pgSeed: () => Promise<void>;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });

    // Full composed adapter (composes every ported domain). initialize() applies the schema.
    pg = createPostgresAdapter({ client: pool });
    await pg.initialize();

    // Overlay the seed store: pgSeedStore isn't in the registry yet, so bind `this` to the full
    // composed adapter and invoke it directly. The ctx mirrors what createPostgresAdapter hands
    // its domains (same pool, same NOW_SQL).
    const ctx = { query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL };
    const seedFn = pgSeedStore(ctx).seedDefaultData!;
    pgSeed = () => seedFn.call(pg);

    sq = tempSqlite();
    await sq.initialize();
    await sq.seedDefaultData();
    await pgSeed();
  }, 240_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── Exact SQLite parity — tables both backends seed from an empty baseline ──

  it('cost policies: identical key sets and count (both seed from empty)', async () => {
    const s = await sq.listCostPolicies();
    const p = await pg.listCostPolicies();
    expect(p.length).toBe(s.length);
    expect(p.length).toBeGreaterThan(0);
    expect(sortedKeys(p, (r) => r.key)).toEqual(sortedKeys(s, (r) => r.key));
    // The four tier presets are present on both.
    for (const tier of ['economy', 'balanced', 'performance', 'max']) {
      expect(sortedKeys(p, (r) => r.key)).toContain(tier);
    }
  });

  it('realm columns (Phase 1): prompts + fragments are global-realm originals with identical content_hash across engines', async () => {
    for (const table of ['prompts', 'prompt_fragments']) {
      const { rows: pRows } = await pool.query(
        `SELECT logical_key, realm, owner_tenant_id, content_hash FROM ${table} ORDER BY logical_key`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sRows = (sq as any).d
        .prepare(`SELECT logical_key, realm, owner_tenant_id, content_hash FROM ${table} ORDER BY logical_key`)
        .all() as Array<{ logical_key: string; realm: string; owner_tenant_id: string | null; content_hash: string }>;

      expect(pRows.length).toBe(sRows.length);
      expect(pRows.length).toBeGreaterThan(0);
      // Every seeded row is a global original: realm='global', no owner, non-empty hash, backfilled key.
      for (const r of pRows as Array<{ logical_key: string; realm: string; owner_tenant_id: string | null; content_hash: string }>) {
        expect(r.realm).toBe('global');
        expect(r.owner_tenant_id == null).toBe(true);
        expect(r.logical_key).toBeTruthy();
        expect(r.content_hash.startsWith('sha256:')).toBe(true);
      }
      // Byte-for-byte parity: same logical_key → same content_hash on both engines (drift stays engine-agnostic).
      const pByKey = new Map((pRows as Array<{ logical_key: string; content_hash: string }>).map((r) => [r.logical_key, r.content_hash]));
      for (const s of sRows) {
        expect(pByKey.get(s.logical_key), `hash mismatch for ${table}.${s.logical_key}`).toBe(s.content_hash);
      }
    }
  });

  it('routing policies: identical id sets and count (both seed from empty)', async () => {
    const s = await sq.listRoutingPolicies();
    const p = await pg.listRoutingPolicies();
    expect(p.length).toBe(s.length);
    expect(p.length).toBeGreaterThan(0);
    expect(sortedKeys(p, (r) => r.id)).toEqual(sortedKeys(s, (r) => r.id));
  });

  it('model_capability_scores: identical (model_id, task_key) sets and count', async () => {
    const { rows: pRows } = await pool.query('SELECT model_id, task_key FROM model_capability_scores');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sRows = (sq as any).d.prepare('SELECT model_id, task_key FROM model_capability_scores').all() as Array<{ model_id: string; task_key: string }>;
    expect(pRows.length).toBe(sRows.length);
    expect(pRows.length).toBeGreaterThan(0);
    const key = (r: { model_id: string; task_key: string }) => `${r.model_id}::${r.task_key}`;
    expect((pRows as Array<{ model_id: string; task_key: string }>).map(key).sort()).toEqual(sRows.map(key).sort());
  });

  it('tenant_encryption_policy: demo row seeded (disabled) on both — exact parity', async () => {
    const { rows: pRows } = await pool.query("SELECT tenant_id, enabled FROM tenant_encryption_policy WHERE tenant_id = 'demo-encrypted-tenant'");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sRow = (sq as any).d.prepare("SELECT tenant_id, enabled FROM tenant_encryption_policy WHERE tenant_id = 'demo-encrypted-tenant'").get() as { tenant_id: string; enabled: number } | undefined;
    expect(pRows.length).toBe(1);
    expect(!!sRow).toBe(true);
    expect(Number(pRows[0].enabled)).toBe(0);
    expect(sRow!.enabled).toBe(0);
  });

  it('provider_tool_adapters: identical provider sets (both seed from empty)', async () => {
    const { rows: pAdapters } = await pool.query('SELECT provider FROM provider_tool_adapters');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sAdapters = (sq as any).d.prepare('SELECT provider FROM provider_tool_adapters').all() as Array<{ provider: string }>;
    expect((pAdapters as Array<{ provider: string }>).map((r) => r.provider).sort()).toEqual(sAdapters.map((r) => r.provider).sort());
    expect((pAdapters as Array<{ provider: string }>).map((r) => r.provider).sort()).toEqual(['anthropic', 'google', 'openai']);
  });

  it('task_type_definitions: Postgres seed populated all 16 canonical task keys', async () => {
    // SQLite pre-seeds a subset via migrations (gating off the seed block), so this is a
    // Postgres-seeded-from-empty presence check rather than SQLite parity.
    const { rows } = await pool.query('SELECT task_key FROM task_type_definitions');
    const keys = new Set((rows as Array<{ task_key: string }>).map((r) => r.task_key));
    for (const k of ['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'image_generation', 'speech_to_text', 'embedding']) {
      expect(keys.has(k)).toBe(true);
    }
  });

  // ── Postgres seed reached the migration-pre-seeded tables (ran end-to-end) ──

  it('skills: Postgres seed populated the built-in skill catalog (via this.createSkill)', async () => {
    const p = await pg.listSkills();
    const pIds = new Set(p.map((r) => r.id));
    for (const s of BUILT_IN_SKILLS) expect(pIds.has(s.id)).toBe(true);
  });

  it('supervisor + worker agents: Postgres seed populated the defaults', async () => {
    const pSup = await pg.listSupervisorAgents();
    expect(pSup.some((r) => r.id === 'agent-supervisor-default')).toBe(true);
    const pWork = await pg.listEnabledWorkerAgents();
    expect(pWork.length).toBeGreaterThan(0);
  });

  it('model pricing: Postgres backfilled output_modality (UPDATE model_pricing ran)', async () => {
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM model_pricing WHERE output_modality IS NULL OR output_modality = ''");
    expect(Number(rows[0].n)).toBe(0);
  });

  it('idempotent: re-running seedDefaultData on Postgres leaves counts unchanged', async () => {
    const before = {
      skills: (await pg.listSkills()).length,
      cost: (await pg.listCostPolicies()).length,
      routing: (await pg.listRoutingPolicies()).length,
      workers: (await pg.listEnabledWorkerAgents()).length,
    };
    const { rows: capBefore } = await pool.query('SELECT COUNT(*) AS n FROM model_capability_scores');

    await pgSeed();

    const after = {
      skills: (await pg.listSkills()).length,
      cost: (await pg.listCostPolicies()).length,
      routing: (await pg.listRoutingPolicies()).length,
      workers: (await pg.listEnabledWorkerAgents()).length,
    };
    const { rows: capAfter } = await pool.query('SELECT COUNT(*) AS n FROM model_capability_scores');

    expect(after).toEqual(before);
    expect(Number(capAfter[0].n)).toBe(Number(capBefore[0].n));
  });
});
