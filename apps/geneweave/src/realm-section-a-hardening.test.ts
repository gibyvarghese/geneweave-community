// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — cross-cutting STRESS + SECURITY hardening for ALL of section A (A1–A6).
 *
 * The per-table suites (skill-realm/worker-agent-realm/guardrail-realm/tool-policy-realm/
 * routing-policy-realm/cost-policy-realm/prompt-catalog-realm) cover positive/negative/isolation/revert/
 * hash. This suite adds, data-driven over EVERY realm-forked table, the two dimensions that matter at
 * scale: (1) STRESS — hundreds of tenants each forking the same logical key, each resolving ONLY its own
 * fork with no cross-tenant leakage; and (2) SECURITY — hostile tenant ids (SQL-injection / overflow)
 * resolve to the global without throwing or corrupting the table, and one tenant's fork is never visible
 * to another. Runs on a real booted SQLite adapter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { newUUIDv7 } from '@weaveintel/core';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import { buildTenantSkillFork, resolveTenantEffectiveSkills } from './skill-realm.js';
import { buildTenantWorkerAgentFork } from './worker-agent-realm.js';
import { buildTenantGuardrailFork } from './guardrail-realm.js';
import { buildTenantToolPolicyFork } from './tool-policy-realm.js';
import { buildTenantRoutingPolicyFork } from './routing-policy-realm.js';
import { buildTenantCostPolicyFork } from './cost-policy-realm.js';
import { buildTenantPromptStrategyFork, buildTenantPromptContractFork, buildTenantPromptFrameworkFork } from './prompt-catalog-realm.js';

/** A realm-forked table, described by the ops needed to stress/secure it uniformly. */
interface TableCfg {
  name: string;
  /** seed a global original if the table isn't seeded by default (returns nothing) */
  seedGlobal?: (db: DatabaseAdapter) => Promise<void>;
  listAll: (db: DatabaseAdapter) => Promise<Array<Record<string, unknown>>>;
  resolve: (db: DatabaseAdapter, tenantId: string | null) => Promise<Array<Record<string, unknown>>>;
  buildFork: (global: never, tenantId: string, marker: string) => Record<string, unknown>;
  insertFork: (db: DatabaseAdapter, row: never) => Promise<void>;
  logical: (r: Record<string, unknown>) => string;
  /** read the marker field back off an effective row */
  readMarker: (r: Record<string, unknown>) => string;
}

const j = (m: string) => JSON.stringify({ marker: m });

const TABLES: TableCfg[] = [
  {
    name: 'skills',
    listAll: (db) => db.listSkills() as Promise<never>,
    resolve: async (db, t) => resolveTenantEffectiveSkills(await db.listSkills(), t) as never,
    buildFork: (g, t, m) => buildTenantSkillFork(g, t, { instructions: m }) as never,
    insertFork: (db, r) => db.insertRealmSkillRow(r),
    logical: (r) => String(r['logical_key'] ?? r['id']),
    readMarker: (r) => String(r['instructions'] ?? ''),
  },
  {
    name: 'worker_agents',
    listAll: (db) => db.listWorkerAgents() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectiveWorkerAgents(t) as never,
    buildFork: (g, t, m) => buildTenantWorkerAgentFork(g, t, { system_prompt: m }) as never,
    insertFork: (db, r) => db.insertRealmWorkerAgentRow(r),
    logical: (r) => String(r['logical_key'] ?? r['name']),
    readMarker: (r) => String(r['system_prompt'] ?? ''),
  },
  {
    name: 'guardrails',
    listAll: (db) => db.listGuardrails() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectiveGuardrails(t) as never,
    buildFork: (g, t, m) => buildTenantGuardrailFork(g, t, { config: j(m) }) as never,
    insertFork: (db, r) => db.insertRealmGuardrailRow(r),
    logical: (r) => String(r['logical_key'] ?? r['name']),
    readMarker: (r) => String(r['config'] ?? ''),
  },
  {
    name: 'tool_policies',
    listAll: (db) => db.listToolPolicies() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectiveToolPolicies(t) as never,
    buildFork: (g, t, m) => buildTenantToolPolicyFork(g, t, { active_hours_utc: j(m) }) as never,
    insertFork: (db, r) => db.insertRealmToolPolicyRow(r),
    logical: (r) => String(r['logical_key'] ?? r['key']),
    readMarker: (r) => String(r['active_hours_utc'] ?? ''),
  },
  {
    name: 'routing_policies',
    listAll: (db) => db.listRoutingPolicies() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectiveRoutingPolicies(t) as never,
    buildFork: (g, t, m) => buildTenantRoutingPolicyFork(g, t, { constraints: j(m) }) as never,
    insertFork: (db, r) => db.insertRealmRoutingPolicyRow(r),
    logical: (r) => String(r['logical_key'] ?? r['name']),
    readMarker: (r) => String(r['constraints'] ?? ''),
  },
  {
    name: 'cost_policies',
    listAll: (db) => db.listCostPolicies() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectiveCostPolicies(t) as never,
    buildFork: (g, t, m) => buildTenantCostPolicyFork(g, t, { levers_json: j(m) }) as never,
    insertFork: (db, r) => db.insertRealmCostPolicyRow(r),
    logical: (r) => String(r['logical_key'] ?? r['key']),
    readMarker: (r) => String(r['levers_json'] ?? ''),
  },
  {
    name: 'prompt_strategies',
    listAll: (db) => db.listPromptStrategies() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectivePromptStrategies(t) as never,
    buildFork: (g, t, m) => buildTenantPromptStrategyFork(g, t, { instruction_prefix: m }) as never,
    insertFork: (db, r) => db.insertRealmPromptStrategyRow(r),
    logical: (r) => String(r['logical_key'] ?? r['key']),
    readMarker: (r) => String(r['instruction_prefix'] ?? ''),
  },
  {
    name: 'prompt_frameworks',
    listAll: (db) => db.listPromptFrameworks() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectivePromptFrameworks(t) as never,
    buildFork: (g, t, m) => buildTenantPromptFrameworkFork(g, t, { section_separator: m }) as never,
    insertFork: (db, r) => db.insertRealmPromptFrameworkRow(r),
    logical: (r) => String(r['logical_key'] ?? r['key']),
    readMarker: (r) => String(r['section_separator'] ?? ''),
  },
  {
    name: 'prompt_contracts',
    seedGlobal: async (db) => {
      await db.insertRealmPromptContractRow({
        id: newUUIDv7(), key: 'harden_contract', name: 'C', description: null, contract_type: 'max_length',
        schema: null, config: JSON.stringify({ maxCharacters: 10 }), enabled: 1, realm: 'global',
        owner_tenant_id: null, logical_key: 'harden_contract', origin_id: null, origin_hash: '',
        content_hash: '', track_mode: 'pin', share_mode: 'private',
      });
    },
    listAll: (db) => db.listPromptContracts() as Promise<never>,
    resolve: (db, t) => db.resolveTenantEffectivePromptContracts(t) as never,
    buildFork: (g, t, m) => buildTenantPromptContractFork(g, t, { config: j(m) }) as never,
    insertFork: (db, r) => db.insertRealmPromptContractRow(r),
    logical: (r) => String(r['logical_key'] ?? r['key']),
    readMarker: (r) => String(r['config'] ?? ''),
  },
];

describe('Tenancy Realm — section A stress + security hardening', () => {
  let db: DatabaseAdapter;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-hardening-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    for (const cfg of TABLES) if (cfg.seedGlobal) await cfg.seedGlobal(db);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  for (const cfg of TABLES) {
    it(`SECURITY (${cfg.name}): hostile tenant ids resolve to globals, no throw, table intact`, async () => {
      const before = (await cfg.listAll(db)).length;
      const hostile = ["'; DROP TABLE " + cfg.name + "; --", "' OR 1=1 --", "a' UNION SELECT * FROM users --", '   ', 'z'.repeat(4096)];
      for (const t of hostile) {
        const eff = await cfg.resolve(db, t);
        // Never surfaces a row owned by a DIFFERENT tenant (only globals or this exact hostile id's own).
        expect(eff.every((r) => (r['realm'] ?? 'global') === 'global' || r['owner_tenant_id'] === t)).toBe(true);
      }
      expect((await cfg.listAll(db)).length).toBe(before); // no rows dropped/added
    });

    it(`SECURITY (${cfg.name}): a tenant's fork is invisible to another tenant`, async () => {
      const base = (await cfg.listAll(db)).find((r) => (r['realm'] ?? 'global') === 'global')!;
      const lk = cfg.logical(base);
      await cfg.insertFork(db, cfg.buildFork(base as never, 'sec-owner', 'OWNER_ONLY') as never);
      const other = (await cfg.resolve(db, 'sec-other')).find((r) => cfg.logical(r) === lk)!;
      expect(cfg.readMarker(other)).not.toContain('OWNER_ONLY');
      const owner = (await cfg.resolve(db, 'sec-owner')).find((r) => cfg.logical(r) === lk)!;
      expect(cfg.readMarker(owner)).toContain('OWNER_ONLY');
    });

    it(`STRESS (${cfg.name}): 150 tenants fork the same key; each resolves only its own, no leak`, async () => {
      const base = (await cfg.listAll(db)).find((r) => (r['realm'] ?? 'global') === 'global')!;
      const lk = cfg.logical(base);
      const tenants = Array.from({ length: 150 }, (_, i) => `${cfg.name}-str-${i}`);
      for (const t of tenants) await cfg.insertFork(db, cfg.buildFork(base as never, t, `M-${t}`) as never);

      for (const t of ['0', '75', '149'].map((n) => `${cfg.name}-str-${n}`)) {
        const eff = await cfg.resolve(db, t);
        const row = eff.find((r) => cfg.logical(r) === lk)!;
        expect(cfg.readMarker(row)).toContain(`M-${t}`);           // its own fork
        // exactly one effective row per logical key — the other 149 forks never leak in
        const keys = eff.map(cfg.logical);
        expect(new Set(keys).size).toBe(keys.length);
      }
      // a tenant with no fork still resolves the global
      const none = (await cfg.resolve(db, 'has-no-fork')).find((r) => cfg.logical(r) === lk)!;
      expect(cfg.readMarker(none)).not.toContain('M-');
    }, 45_000);
  }
});
