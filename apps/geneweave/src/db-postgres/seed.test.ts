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
import { buildTenantToolPolicyFork, toolPolicyContentHash } from '../tool-policy-realm.js';
import type { ToolPolicyRow } from '../db-types/tools.js';
import { buildTenantRoutingPolicyFork, routingContentHash } from '../routing-policy-realm.js';
import { buildTenantCostPolicyFork, costContentHash } from '../cost-policy-realm.js';
import { buildTenantPromptStrategyFork, promptStrategyContentHash, promptFrameworkContentHash, buildTenantPromptContractFork } from '../prompt-catalog-realm.js';
import type { PromptContractRow } from '../db-types/prompts.js';

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
    // Scope to global originals — the m158 realm test inserts per-tenant forks into this shared table.
    const s = (await sq.listCostPolicies()).filter((r) => (r.realm ?? 'global') === 'global');
    const p = (await pg.listCostPolicies()).filter((r) => (r.realm ?? 'global') === 'global');
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

  it('realm columns on tool_policies (m157): a global original + a tenant fork resolve identically on both engines with UNIQUE(key) intact', async () => {
    // tool_policies are seeded on SQLite by bootstrap migrations (and backfilled by m157) but NOT on
    // Postgres (the PG seeder creates none), so there's no shared seeded row to compare. Instead insert
    // an identical GLOBAL original on each engine and prove the fork/resolve round-trip is identical.
    // The seeded SQLite 'default' also proves m157's backfill == the canonical JS hash.
    const sqDefault = await sq.getToolPolicyByKey('default');
    expect(sqDefault, 'SQLite seeds the default tool policy').toBeTruthy();
    expect(sqDefault!.logical_key).toBe('default');
    expect(sqDefault!.content_hash).toBe(toolPolicyContentHash(sqDefault!)); // backfill == canonical JS hash

    for (const db of [pg, sq]) {
      const suffix = db === pg ? 'pg' : 'sq';
      const key = `parity_pol_${suffix}`;
      const globalRow: Omit<ToolPolicyRow, 'created_at' | 'updated_at'> = {
        id: `tp-parity-${suffix}`, key, name: 'Parity Policy', description: 'p',
        applies_to: null, applies_to_risk_levels: null, approval_required: 0, allowed_risk_levels: JSON.stringify(['low']),
        max_execution_ms: 5000, rate_limit_per_minute: null, max_concurrent: null, require_dry_run: 0,
        log_input_output: 1, persona_scope: null, active_hours_utc: null, expires_at: null, enabled: 1,
        realm: 'global', owner_tenant_id: null, logical_key: key, origin_id: null, origin_hash: '',
        content_hash: '', track_mode: 'pin', share_mode: 'private',
      };
      globalRow.content_hash = toolPolicyContentHash(globalRow);
      globalRow.origin_hash = globalRow.content_hash;
      await db.insertRealmToolPolicyRow(globalRow);

      const g = (await db.getToolPolicyByKey(key))!;
      await db.insertRealmToolPolicyRow(buildTenantToolPolicyFork(g, 'tp-acme', { max_execution_ms: 42 }));

      const forAcme = await db.getEffectiveToolPolicyByKey(key, 'tp-acme');
      expect(Number(forAcme!.max_execution_ms)).toBe(42);
      expect(forAcme!.key).toBe(key); // canonical key restored (UNIQUE(key) kept via key#tenant alias)
      const forGlobex = await db.getEffectiveToolPolicyByKey(key, 'tp-globex');
      expect(Number(forGlobex!.max_execution_ms)).toBe(5000); // other tenants keep the global
    }
  });

  it('realm columns on routing_policies + cost_policies (m158): built-ins are global originals whose backfilled content_hash matches the canonical JS hash on BOTH engines, and a fork resolves per tenant', async () => {
    // Both tables are seeded from empty on BOTH engines, so the backfill runs on identical rows.
    // Assert each engine's backfill == the canonical JS hash, and cross-engine hashes match by key.
    for (const db of [pg, sq]) {
      const routing = (await db.listRoutingPolicies()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(routing.length).toBeGreaterThan(0);
      for (const r of routing) {
        expect(r.logical_key, `routing logical_key ${r.name}`).toBe(r.name);
        expect(r.content_hash, `routing backfill==JS hash ${r.name}`).toBe(routingContentHash(r));
        expect(r.origin_hash, `routing origin_hash ${r.name}`).toBe(r.content_hash);
      }
      const cost = (await db.listCostPolicies()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(cost.length).toBeGreaterThan(0);
      for (const c of cost) {
        expect(c.logical_key, `cost logical_key ${c.key}`).toBe(c.key);
        expect(c.content_hash, `cost backfill==JS hash ${c.key}`).toBe(costContentHash(c));
        expect(c.origin_hash, `cost origin_hash ${c.key}`).toBe(c.content_hash);
      }
    }
    // Cross-engine content_hash matches by logical key (both engines seed the same built-ins).
    const rBy = new Map((await sq.listRoutingPolicies()).map((r) => [r.logical_key ?? r.name, r.content_hash]));
    for (const r of (await pg.listRoutingPolicies())) expect(rBy.get(r.logical_key ?? r.name), `x-engine routing ${r.name}`).toBe(r.content_hash);
    const cBy = new Map((await sq.listCostPolicies()).map((c) => [c.logical_key ?? c.key, c.content_hash]));
    for (const c of (await pg.listCostPolicies())) expect(cBy.get(c.logical_key ?? c.key), `x-engine cost ${c.key}`).toBe(c.content_hash);

    // A fork of each resolves for its tenant on both engines; other tenants keep the global.
    for (const db of [pg, sq]) {
      const rg = (await db.listRoutingPolicies()).find((x) => (x.realm ?? 'global') === 'global')!;
      await db.insertRealmRoutingPolicyRow(buildTenantRoutingPolicyFork(rg, 'rc-acme', { strategy: 'ACME_STRAT' }));
      const rForAcme = (await db.resolveTenantEffectiveRoutingPolicies('rc-acme')).find((x) => (x.logical_key ?? x.name) === (rg.logical_key ?? rg.name))!;
      expect(rForAcme.strategy).toBe('ACME_STRAT');
      expect(rForAcme.name).toBe(rg.name);
      const rForGlobex = (await db.resolveTenantEffectiveRoutingPolicies('rc-globex')).find((x) => (x.logical_key ?? x.name) === (rg.logical_key ?? rg.name))!;
      expect(rForGlobex.strategy).not.toBe('ACME_STRAT');

      const cg = (await db.getCostPolicyByKey('balanced'))!;
      await db.insertRealmCostPolicyRow(buildTenantCostPolicyFork(cg, 'rc-acme', { tier: 'economy' }));
      const cForAcme = await db.getEffectiveCostPolicyByKey('balanced', 'rc-acme');
      expect(cForAcme!.tier).toBe('economy');
      expect(cForAcme!.key).toBe('balanced'); // canonical key restored (UNIQUE(key) kept via key#tenant)
      const cForGlobex = await db.getEffectiveCostPolicyByKey('balanced', 'rc-globex');
      expect(cForGlobex!.tier).toBe(cg.tier);
    }
  });

  it('realm columns on prompt catalog (m159): strategies/frameworks backfill == canonical JS hash on BOTH engines (+ x-engine match); strategy + contract forks resolve per tenant', async () => {
    for (const db of [pg, sq]) {
      const strategies = (await db.listPromptStrategies()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(strategies.length).toBeGreaterThan(0);
      for (const s of strategies) {
        expect(s.logical_key, `strategy logical_key ${s.key}`).toBe(s.key);
        expect(s.content_hash, `strategy backfill==JS hash ${s.key}`).toBe(promptStrategyContentHash(s));
        expect(s.origin_hash, `strategy origin_hash ${s.key}`).toBe(s.content_hash);
      }
      const frameworks = (await db.listPromptFrameworks()).filter((x) => (x.realm ?? 'global') === 'global');
      expect(frameworks.length).toBeGreaterThan(0);
      for (const f of frameworks) {
        expect(f.logical_key, `framework logical_key ${f.key}`).toBe(f.key);
        expect(f.content_hash, `framework backfill==JS hash ${f.key}`).toBe(promptFrameworkContentHash(f));
      }
    }
    const sBy = new Map((await sq.listPromptStrategies()).map((s) => [s.logical_key ?? s.key, s.content_hash]));
    for (const s of (await pg.listPromptStrategies())) expect(sBy.get(s.logical_key ?? s.key), `x-engine strategy ${s.key}`).toBe(s.content_hash);
    const fBy = new Map((await sq.listPromptFrameworks()).map((f) => [f.logical_key ?? f.key, f.content_hash]));
    for (const f of (await pg.listPromptFrameworks())) expect(fBy.get(f.logical_key ?? f.key), `x-engine framework ${f.key}`).toBe(f.content_hash);

    for (const db of [pg, sq]) {
      const sg = (await db.listPromptStrategies()).find((x) => (x.realm ?? 'global') === 'global')!;
      await db.insertRealmPromptStrategyRow(buildTenantPromptStrategyFork(sg, 'pc-acme', { instruction_prefix: 'ACME_PFX' }));
      const sForAcme = (await db.resolveTenantEffectivePromptStrategies('pc-acme')).find((x) => (x.logical_key ?? x.key) === (sg.logical_key ?? sg.key))!;
      expect(sForAcme.instruction_prefix).toBe('ACME_PFX');
      expect(sForAcme.key).toBe(sg.key);
      const sForGlobex = (await db.resolveTenantEffectivePromptStrategies('pc-globex')).find((x) => (x.logical_key ?? x.key) === (sg.logical_key ?? sg.key))!;
      expect(sForGlobex.instruction_prefix).not.toBe('ACME_PFX');

      const suffix = db === pg ? 'pg' : 'sq';
      const cKey = `pc_contract_${suffix}`;
      const globalC: Omit<PromptContractRow, 'created_at' | 'updated_at'> = {
        id: `pcc-${suffix}`, key: cKey, name: 'C', description: null, contract_type: 'max_length', schema: null,
        config: JSON.stringify({ maxCharacters: 10 }), enabled: 1, realm: 'global', owner_tenant_id: null,
        logical_key: cKey, origin_id: null, origin_hash: '', content_hash: '', track_mode: 'pin', share_mode: 'private',
      };
      await db.insertRealmPromptContractRow(globalC);
      const cg = (await db.getPromptContractByKey(cKey))!;
      await db.insertRealmPromptContractRow(buildTenantPromptContractFork(cg, 'pc-acme', { config: JSON.stringify({ maxCharacters: 999 }) }));
      const cForAcme = (await db.resolveTenantEffectivePromptContracts('pc-acme')).find((x) => (x.logical_key ?? x.key) === cKey)!;
      expect(cForAcme.config).toContain('999');
      expect(cForAcme.key).toBe(cKey);
      const cForGlobex = (await db.resolveTenantEffectivePromptContracts('pc-globex')).find((x) => (x.logical_key ?? x.key) === cKey)!;
      expect(cForGlobex.config).not.toContain('999');
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

  it('Section C10 (note_action_modes): Postgres now seeds the 5 global defaults, matching SQLite (parity-bug fix)', async () => {
    // Before C10, only the SQLite m117 migration seeded these; Postgres had an empty table, so
    // resolveNoteActionMode returned 'direct' for every action. The PG seed block restores parity.
    const expected: Record<string, string> = { diagram: 'supervisor', ink: 'supervisor', visual: 'supervisor', restructure: 'supervisor', illustration: 'direct' };
    for (const [action, mode] of Object.entries(expected)) {
      expect(await pg.resolveNoteActionMode(null, action), `pg global ${action}`).toBe(mode);
      expect(await sq.resolveNoteActionMode(null, action), `sq global ${action}`).toBe(mode);
    }
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM note_action_modes WHERE tenant_id = ''`);
    expect((rows[0] as { c: number }).c).toBe(5);
  });

  it('Section C (note_action_modes + capability_scores): nearest-owner-wins down a real lineage on both engines', async () => {
    const { createSqlTenantHierarchy } = await import('@weaveintel/identity');
    for (const [db, client] of [
      [pg, pool as unknown as import('@weaveintel/realm').SqlClient],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [sq, { async query(t: string, p: unknown[] = []) { const s = (sq as any).d.prepare(t); return /^\s*(SELECT|PRAGMA|WITH)/i.test(t) ? { rows: s.all(...p) } : (s.run(...p), { rows: [] }); } }],
    ] as const) {
      const org = createSqlTenantHierarchy({ client, dialect: db === pg ? 'postgres' : 'sqlite', table: 'tenants', ensureSchema: false });
      await org.create({ id: 'c-acme', name: 'A' });
      await org.create({ id: 'c-emea', name: 'E', parentTenantId: 'c-acme' });
      await org.create({ id: 'c-uk', name: 'U', parentTenantId: 'c-emea' });
      await org.create({ id: 'c-apac', name: 'P', parentTenantId: 'c-acme' });

      // C10: emea sets diagram=direct; uk inherits it; apac (sibling) keeps the global 'supervisor'.
      await db.createNoteActionMode({ id: randomUUID(), tenant_id: 'c-emea', action_key: 'diagram', mode: 'direct' });
      expect(await db.resolveNoteActionMode('c-uk', 'diagram')).toBe('direct');
      expect(await db.resolveNoteActionMode('c-apac', 'diagram')).toBe('supervisor');
      // uk overrides for itself → own wins.
      await db.createNoteActionMode({ id: randomUUID(), tenant_id: 'c-uk', action_key: 'diagram', mode: 'agent' });
      expect(await db.resolveNoteActionMode('c-uk', 'diagram')).toBe('agent');

      // C11: emea tunes a capability cell; uk inherits; apac gets the global; uk then overrides.
      const cell = { model_id: 'gpt-cparity', provider: 'openai', task_key: 'reasoning' };
      const scoreFields = { supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 1, supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0 };
      await db.upsertCapabilityScore({ id: randomUUID(), tenant_id: null, ...cell, quality_score: 40, ...scoreFields });
      await db.upsertCapabilityScore({ id: randomUUID(), tenant_id: 'c-emea', ...cell, quality_score: 75, ...scoreFields });
      const qOf = async (t: string | null) => (await db.resolveTenantEffectiveCapabilityScores(t, 'reasoning')).find((r) => r.model_id === 'gpt-cparity')?.quality_score;
      expect(await qOf('c-uk')).toBe(75);   // inherits emea
      expect(await qOf('c-apac')).toBe(40); // sibling → global
      await db.upsertCapabilityScore({ id: randomUUID(), tenant_id: 'c-uk', ...cell, quality_score: 95, ...scoreFields });
      expect(await qOf('c-uk')).toBe(95);   // own wins
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
    // Scope to global originals — the m158 realm test inserts per-tenant forks (with per-engine UUIDs)
    // into this shared table, so only the seeded globals are comparable across engines.
    const s = (await sq.listRoutingPolicies()).filter((r) => (r.realm ?? 'global') === 'global');
    const p = (await pg.listRoutingPolicies()).filter((r) => (r.realm ?? 'global') === 'global');
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

  // ── Tenancy Realm Section D (write path & governance) ──
  // Declared LAST on purpose: promote appends a realm_versions row and deprecation mutates a global,
  // which would break the count/hash parity assertions above if these ran first (fork-pollution).
  it('Section D (m160): realm_proposals + the deprecation columns exist on every realm table, on both engines', async () => {
    const { REALM_FAMILIES } = await import('../realm-families.js');
    // realm_proposals + its partial unique index (one PENDING proposal per fork)
    const { rows: t } = await pool.query(`SELECT to_regclass('public.realm_proposals') IS NOT NULL AS ok`);
    expect((t[0] as { ok: boolean }).ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sq as any).d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='realm_proposals'`).get()).toBeTruthy();

    for (const spec of Object.values(REALM_FAMILIES)) {
      const { rows: c } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('deprecated_at','deprecation_note','superseded_by_id')`,
        [spec.table],
      );
      expect((c as Array<{ column_name: string }>).map((r) => r.column_name).sort(), `pg ${spec.table}`)
        .toEqual(['deprecated_at', 'deprecation_note', 'superseded_by_id']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = ((sq as any).d.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map((x) => x.name);
      for (const col of ['deprecated_at', 'deprecation_note', 'superseded_by_id']) {
        expect(names, `sqlite ${spec.table}.${col}`).toContain(col);
      }
    }
  });

  it('Section D: propose → approve (generic promote), deprecation, and reparent behave identically on both engines', async () => {
    const {
      promoteRealmForkToGlobal, proposeRealmFork, approveRealmProposal, rejectRealmProposal,
      deprecateRealmRecord, checkVisibleKeyCollision, reparentTenant,
    } = await import('../realm-governance.js');
    const { createSqlTenantHierarchy } = await import('@weaveintel/identity');

    for (const [db, client, dialect] of [
      [pg, pool as unknown as import('@weaveintel/realm').SqlClient, 'postgres'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [sq, { async query(t: string, p: unknown[] = []) { const s = (sq as any).d.prepare(t); return /^\s*(SELECT|PRAGMA|WITH)/i.test(t) ? { rows: s.all(...p) } : (s.run(...p), { rows: [] }); } }, 'sqlite'],
    ] as const) {
      const org = createSqlTenantHierarchy({ client, dialect, table: 'tenants', ensureSchema: false });
      await org.create({ id: 'd-root', name: 'R' });
      await org.create({ id: 'd-emea', name: 'E', parentTenantId: 'd-root' });
      await org.create({ id: 'd-uk', name: 'U', parentTenantId: 'd-emea' });

      const base = (await db.listPrompts()).find((p) => (p.realm ?? 'global') === 'global' && !!p.template)!;
      const key = base.logical_key ?? base.key!;
      await db.insertRealmPromptRow(buildTenantPromptFork(base, 'd-emea', { template: 'D-SECTION PROMOTED' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'd-emea' && (p.logical_key ?? p.key) === key)!;

      // D12: propose is idempotent per fork, approve promotes, double-review is refused.
      const p1 = await proposeRealmFork(client, dialect, 'prompts', fork.id, { note: 'a' });
      const p2 = await proposeRealmFork(client, dialect, 'prompts', fork.id, { note: 'b' });
      expect(p2.proposal!.id, `${dialect}: one pending proposal per fork`).toBe(p1.proposal!.id);
      expect((await approveRealmProposal(client, dialect, p1.proposal!.id, { reviewer: 'plat' })).ok).toBe(true);
      expect((await db.listPrompts()).find((p) => p.id === base.id)!.template).toBe('D-SECTION PROMOTED');
      expect((await rejectRealmProposal(client, dialect, p1.proposal!.id, {})).reason).toMatch(/already approved/);
      // promoting the (now identical) fork again is still a valid no-op promote, not an error
      expect((await promoteRealmForkToGlobal(client, dialect, 'prompts', fork.id)).ok).toBe(true);

      // D17: the promoted key is visible to uk → must customize, not create a twin.
      const ctxUk = await db.realmContext('d-uk');
      expect((await checkVisibleKeyCollision(client, dialect, 'prompts', key, ctxUk)).collides).toBe(true);
      expect((await checkVisibleKeyCollision(client, dialect, 'prompts', 'no-such-key', ctxUk)).collides).toBe(false);

      // D15: deprecate blocks new proposals but the record still resolves.
      expect((await deprecateRealmRecord(client, dialect, 'prompts', base.id, { note: 'retired' })).ok).toBe(true);
      expect((await proposeRealmFork(client, dialect, 'prompts', fork.id, {})).reason).toMatch(/deprecated/);
      expect((await db.listPrompts()).find((p) => p.id === base.id)!.template).toBe('D-SECTION PROMOTED');
      expect((await deprecateRealmRecord(client, dialect, 'prompts', base.id, { supersededById: base.id })).reason).toMatch(/supersede itself/);

      // D16: reparent moves the subtree, reports it, and is cycle-safe.
      const moved = await reparentTenant(client, dialect, 'd-emea', null);
      expect(moved.ok).toBe(true);
      expect(moved.to!.parentTenantId).toBeNull();
      expect(new Set(moved.affectedTenantIds), `${dialect}: subtree`).toEqual(new Set(['d-emea', 'd-uk']));
      expect((await reparentTenant(client, dialect, 'd-emea', 'd-uk')).ok, `${dialect}: cycle refused`).toBe(false);
      expect((await reparentTenant(client, dialect, 'ghost', null)).reason).toBe('tenant not found');
    }
  });

  it('Section D13 (prompt_fragments): a tenant fork resolves under the canonical key on both engines', async () => {
    const { buildTenantPromptFragmentFork, fragmentContentHash } = await import('../prompt-fragment-realm.js');
    for (const db of [pg, sq]) {
      const id = randomUUID();
      await db.createPromptFragment({
        id, key: 'd13.frag', name: 'F', description: null, category: null,
        content: 'GLOBAL FRAG', variables: null, tags: null, version: '1', enabled: 1,
      });
      // Classify as a global realm original. The hash must be a REAL sha256 over the semantic fields:
      // the Phase-1 parity test asserts every global's content_hash starts with 'sha256:'.
      const h = fragmentContentHash({ name: 'F', description: null, category: null, content: 'GLOBAL FRAG', variables: null });
      await (db === pg
        ? pool.query(`UPDATE prompt_fragments SET realm='global', logical_key='d13.frag', content_hash=$2 WHERE id=$1`, [id, h])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : Promise.resolve((sq as any).d.prepare(`UPDATE prompt_fragments SET realm='global', logical_key='d13.frag', content_hash=? WHERE id=?`).run(h, id)));

      const global = (await db.listPromptFragments()).find((f) => f.id === id)!;
      const fork = buildTenantPromptFragmentFork(global, 'd-frag-tenant', { content: 'TENANT FRAG' });
      expect(fork.key).toBe('d13.frag#d-frag-tenant');   // UNIQUE(key) → aliased
      expect(fork.logical_key).toBe('d13.frag');
      await db.insertRealmPromptFragmentRow(fork);

      const eff = (await db.resolveTenantEffectivePromptFragments('d-frag-tenant')).find((f) => (f.logical_key ?? f.key) === 'd13.frag')!;
      expect(eff.content).toBe('TENANT FRAG');
      expect(eff.key, 'canonical key restored so {{>key}} still resolves').toBe('d13.frag');
      // globals-only for no tenant
      expect((await db.resolveTenantEffectivePromptFragments(null)).some((f) => f.content === 'TENANT FRAG')).toBe(false);
    }
  });
});
