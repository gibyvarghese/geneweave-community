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
import { buildTenantPromptFork } from '../chat-realm-prompt.js';
import { buildTenantSkillFork, resolveTenantEffectiveSkills } from '../skill-realm.js';
import { buildTenantWorkerAgentFork, workerContentHash } from '../worker-agent-realm.js';
import { buildTenantGuardrailFork, guardrailContentHash } from '../guardrail-realm.js';

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
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown

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

  it('realm columns on skills (m154): built-ins are global originals with identical content_hash across engines, and a fork resolves per tenant', async () => {
    // NOTE: skill COUNTS differ by design (SQLite pre-seeds ~17 via bootstrap migrations; the PG seed
    // populates fewer from empty — see the parity-scope note above). So compare content_hash only for the
    // logical keys present on BOTH engines, and require the built-in set to overlap.
    const { rows: pRows } = await pool.query(`SELECT logical_key, content_hash FROM skills WHERE realm='global'`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sRows = (sq as any).d.prepare(`SELECT logical_key, content_hash FROM skills WHERE realm='global'`).all() as Array<{ logical_key: string; content_hash: string }>;
    const pByKey = new Map((pRows as Array<{ logical_key: string; content_hash: string }>).map((r) => [r.logical_key, r.content_hash]));
    const shared = sRows.filter((s) => pByKey.has(s.logical_key));
    expect(shared.length).toBeGreaterThan(0); // the two engines share at least the core built-ins
    for (const s of shared) expect(pByKey.get(s.logical_key), `skill hash mismatch ${s.logical_key}`).toBe(s.content_hash);

    // A fork resolves for its tenant on both engines; another tenant gets the global.
    for (const db of [pg, sq]) {
      const g = (await db.listSkills()).find((x) => (x.realm ?? 'global') === 'global')!;
      await db.insertRealmSkillRow(buildTenantSkillFork(g, 'sk-acme', { instructions: 'ACME SKILL EDIT' }));
      const all = await db.listSkills();
      const forAcme = resolveTenantEffectiveSkills(all, 'sk-acme').find((x) => (x.logical_key ?? x.id) === (g.logical_key ?? g.id))!;
      const forGlobex = resolveTenantEffectiveSkills(all, 'sk-globex').find((x) => (x.logical_key ?? x.id) === (g.logical_key ?? g.id))!;
      expect(forAcme.instructions).toBe('ACME SKILL EDIT');
      expect(forGlobex.instructions).not.toBe('ACME SKILL EDIT');
    }
  });

  it('realm columns on worker_agents (m155): built-ins are global originals whose backfilled content_hash matches the canonical JS hash on BOTH engines, and a fork resolves per tenant with UNIQUE(name) intact', async () => {
    // The two backends seed DISJOINT worker sets (SQLite pre-seeds weave_*/sv-* via bootstrap
    // migrations; the PG seed block seeds code_executor/researcher/analyst/writer/statsnz from an
    // empty baseline — see PARITY SCOPE). Cross-engine set-equality is therefore meaningless here.
    // The real parity claim is the HASH ALGORITHM: each engine's backfill (PG SQL-path vs SQLite
    // JS-path) must produce the SAME canonical content_hash for the SAME row content. Assert that
    // directly — every seeded global's stored content_hash equals workerContentHash recomputed in JS.
    for (const db of [pg, sq]) {
      const globals = (await db.listWorkerAgents()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(globals.length).toBeGreaterThan(0);
      for (const g of globals) {
        expect(g.logical_key, `logical_key set for ${g.name}`).toBe(g.name);
        expect(g.content_hash?.startsWith('sha256:'), `sha256 content_hash for ${g.name}`).toBe(true);
        expect(g.content_hash, `backfill == canonical JS hash for ${g.name}`).toBe(workerContentHash(g));
        expect(g.origin_hash, `origin_hash baseline for ${g.name}`).toBe(g.content_hash);
      }
    }

    // A fork (tenant-scoped name) resolves for its tenant on both engines with the canonical name restored.
    for (const db of [pg, sq]) {
      const g = (await db.listWorkerAgents()).find((x) => (x.realm ?? 'global') === 'global')!;
      await db.insertRealmWorkerAgentRow(buildTenantWorkerAgentFork(g, 'wa-acme', { system_prompt: 'ACME WORKER EDIT' }));
      const forAcme = (await db.resolveTenantEffectiveWorkerAgents('wa-acme')).find((x) => (x.logical_key ?? x.name) === (g.logical_key ?? g.name))!;
      expect(forAcme.system_prompt).toBe('ACME WORKER EDIT');
      expect(forAcme.name).toBe(g.name); // canonical name restored
      const forGlobex = (await db.resolveTenantEffectiveWorkerAgents('wa-globex')).find((x) => (x.logical_key ?? x.name) === (g.logical_key ?? g.name))!;
      expect(forGlobex.system_prompt).not.toBe('ACME WORKER EDIT');
    }
  });

  it('realm columns on guardrails (m156): built-ins are global originals whose backfilled content_hash matches the canonical JS hash on BOTH engines, and a fork resolves per tenant', async () => {
    // The real parity claim is the HASH ALGORITHM: each engine's backfill (PG SQL-path vs SQLite
    // JS-path) must produce the SAME canonical content_hash for the SAME policy content.
    for (const db of [pg, sq]) {
      const globals = (await db.listGuardrails()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(globals.length).toBeGreaterThan(0);
      for (const g of globals) {
        expect(g.logical_key, `logical_key set for ${g.name}`).toBe(g.name);
        expect(g.content_hash?.startsWith('sha256:'), `sha256 content_hash for ${g.name}`).toBe(true);
        expect(g.content_hash, `backfill == canonical JS hash for ${g.name}`).toBe(guardrailContentHash(g));
        expect(g.origin_hash, `origin_hash baseline for ${g.name}`).toBe(g.content_hash);
      }
    }
    // Where the two engines seed the SAME guardrail (shared logical_key), the content_hash matches byte-for-byte.
    const pGlobals = (await pg.listGuardrails()).filter((x) => (x.realm ?? 'global') === 'global');
    const sByKey = new Map((await sq.listGuardrails()).filter((x) => (x.realm ?? 'global') === 'global').map((g) => [g.logical_key ?? g.name, g.content_hash]));
    const sharedG = pGlobals.filter((g) => sByKey.has(g.logical_key ?? g.name));
    expect(sharedG.length).toBeGreaterThan(0);
    for (const g of sharedG) expect(sByKey.get(g.logical_key ?? g.name), `cross-engine hash ${g.name}`).toBe(g.content_hash);

    // A fork resolves for its tenant on both engines; other tenants keep the global.
    for (const db of [pg, sq]) {
      const g = (await db.listGuardrails()).find((x) => (x.realm ?? 'global') === 'global')!;
      const cfg = JSON.stringify({ ...(g.config ? JSON.parse(g.config) : {}), tenantMarker: 'ACME_GR_EDIT' });
      await db.insertRealmGuardrailRow(buildTenantGuardrailFork(g, 'gr-acme', { config: cfg }));
      const forAcme = (await db.resolveTenantEffectiveGuardrails('gr-acme')).find((x) => (x.logical_key ?? x.name) === (g.logical_key ?? g.name))!;
      expect(forAcme.config).toContain('ACME_GR_EDIT');
      expect(forAcme.name).toBe(g.name);
      const forGlobex = (await db.resolveTenantEffectiveGuardrails('gr-globex')).find((x) => (x.logical_key ?? x.name) === (g.logical_key ?? g.name))!;
      expect(forGlobex.config ?? '').not.toContain('ACME_GR_EDIT');
    }
  });

  it('realm hierarchy (Phase 4): a real lineage + share blast radius resolve identically on both engines', async () => {
    const { createSqlTenantHierarchy } = await import('@weaveintel/identity');
    for (const [db, client] of [
      [pg, pool as unknown as import('@weaveintel/realm').SqlClient],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [sq, { async query(t: string, p: unknown[] = []) { const s = (sq as any).d.prepare(t); return /^\s*(SELECT|PRAGMA|WITH)/i.test(t) ? { rows: s.all(...p) } : (s.run(...p), { rows: [] }); } }],
    ] as const) {
      const org = createSqlTenantHierarchy({ client, dialect: db === pg ? 'postgres' : 'sqlite', table: 'tenants', ensureSchema: false });
      await org.create({ id: 'p4-acme', name: 'A' });
      await org.create({ id: 'p4-emea', name: 'E', parentTenantId: 'p4-acme' });
      await org.create({ id: 'p4-uk', name: 'U', parentTenantId: 'p4-emea' });

      // The real lineage is root → self (depth 2 for uk).
      const ctx = await db.realmContext('p4-uk');
      expect(ctx.lineage.map((n) => n.tenantId)).toEqual(['p4-acme', 'p4-emea', 'p4-uk']);
      expect(ctx.depth).toBe(2);

      // EMEA forks a prompt + shares to subtree → blast radius reaches uk.
      const g = (await db.listPrompts()).find((p) => (p.realm ?? 'global') === 'global')!;
      const fork = buildTenantPromptFork(g, 'p4-emea', { template: 'shared', share_mode: 'subtree' });
      await db.insertRealmPromptRow(fork);
      const forkRow = (await db.listPrompts()).find((p) => p.owner_tenant_id === 'p4-emea')!;
      const radius = await db.promptShareBlastRadius(forkRow.id, 'subtree');
      expect('error' in radius ? [] : radius.inheriting).toContain('p4-uk');
    }
  });

  it('realm state overlay (Phase 3): disabling a built-in for a tenant behaves identically on both engines', async () => {
    const skill = (await pg.listEnabledSkills())[0]!.id;
    for (const db of [pg, sq]) {
      await db.setRealmState('skills', skill, 'acme', { enabled: false });
      await db.setRealmState('skills', skill, 'acme', { priority: 7 }); // merge, keep disabled
      const acme = (await db.resolveRealmStates('skills', 'acme', [skill])).get(skill)!;
      expect([acme.active, acme.priority]).toEqual([false, 7]);
      expect((await db.resolveRealmStates('skills', 'globex', [skill])).get(skill)!.active).toBe(true); // isolation
      await db.clearRealmState('skills', skill, 'acme');
      expect((await db.resolveRealmStates('skills', 'acme', [skill])).get(skill)!.active).toBe(true);
    }
  });

  it('realm versions (Phase 2): both engines record one baseline per built-in prompt and report every one in_sync', async () => {
    // One realm_versions baseline per global prompt, identical count across engines.
    const { rows: pv } = await pool.query(`SELECT count(*)::int AS c FROM realm_versions WHERE family='prompts'`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sv = (sq as any).d.prepare(`SELECT count(*) AS c FROM realm_versions WHERE family='prompts'`).get() as { c: number };
    const globals = (await pg.listPrompts()).filter((p) => (p.realm ?? 'global') === 'global').length;
    expect((pv[0] as { c: number }).c).toBe(globals);
    expect(sv.c).toBe(globals);

    // A fresh install is fully in sync on both engines (drift report).
    const pgDrift = await pg.promptDriftReport();
    const sqDrift = await sq.promptDriftReport();
    expect(pgDrift.summary.customized + pgDrift.summary.stale + pgDrift.summary.diverged).toBe(0);
    expect(sqDrift.summary).toEqual(pgDrift.summary);
    expect(pgDrift.summary.in_sync).toBe(globals);
  });

  it('realm columns (Phase 1): prompts + fragments are global-realm originals with identical content_hash across engines', async () => {
    for (const table of ['prompts', 'prompt_fragments']) {
      const { rows: pRows } = await pool.query(
        `SELECT logical_key, realm, owner_tenant_id, content_hash FROM ${table} WHERE realm = 'global' ORDER BY logical_key`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sRows = (sq as any).d
        .prepare(`SELECT logical_key, realm, owner_tenant_id, content_hash FROM ${table} WHERE realm = 'global' ORDER BY logical_key`)
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
