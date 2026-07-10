// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Section C consolidation, end to end on a real booted SQLite adapter over a real org
 * tree (acme → emea → uk; acme → apac). Three legacy ad-hoc per-tenant override tables are consolidated
 * onto the shared realm resolver (nearest-owner-wins down the lineage), gaining hierarchy inheritance:
 *   • C10 note_action_modes           — weaveNotes AI action execution mode (direct/agent/supervisor)
 *   • C9  task_type_tenant_overrides   — per-tenant routing weight/model overrides (simulator surface)
 *   • C11 model_capability_scores      — per-(provider,model,task) quality scores for routing
 * Positive / inheritance / override / isolation / null-tenant / negative / stress / security coverage,
 * plus pure-resolver unit tests that need no database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { newUUIDv7 } from './lib/uuid.js';
import { resolveTenantEffectiveNoteActionMode } from './note-action-realm.js';
import { resolveTenantEffectiveTaskTypeOverrides } from './task-override-realm.js';
import { resolveTenantEffectiveCapabilityScores } from './capability-score-realm.js';
import type { NoteActionModeRow } from './db-types/adapter-me.js';
import type { TaskTypeTenantOverrideRow, ModelCapabilityScoreRow } from './db-types/routing.js';

const HOSTILE = "'; DROP TABLE note_action_modes; --";

describe('Tenancy Realm — Section C consolidation (real adapter + org tree)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-section-c-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    // Real org tree: acme → emea → uk;  acme → apac
    const org = createSqlTenantHierarchy({ client: sqliteSqlClient(raw()), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
    await org.create({ id: 'acme', name: 'Acme' });
    await org.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await org.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    await org.create({ id: 'apac', name: 'APAC', parentTenantId: 'acme' });
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  // ─────────────────────────────── C10 note_action_modes ───────────────────────────────
  describe('C10 — note_action_modes', () => {
    it('POSITIVE: the seeded global defaults resolve for a plain tenant and for no tenant', async () => {
      expect(await db.resolveNoteActionMode(null, 'diagram')).toBe('supervisor');
      expect(await db.resolveNoteActionMode('apac', 'illustration')).toBe('direct');
      expect(await db.resolveNoteActionMode('apac', 'diagram')).toBe('supervisor'); // inherits global
    });

    it('INHERITANCE: a parent org (emea) sets a mode; the child (uk) inherits it', async () => {
      await db.createNoteActionMode({ id: newUUIDv7(), tenant_id: 'emea', action_key: 'diagram', mode: 'direct' });
      expect(await db.resolveNoteActionMode('uk', 'diagram')).toBe('direct');   // uk inherits emea
      expect(await db.resolveNoteActionMode('apac', 'diagram')).toBe('supervisor'); // sibling branch → global
      expect(await db.resolveNoteActionMode('emea', 'diagram')).toBe('direct');  // emea's own
    });

    it('OVERRIDE: the child (uk) sets its own mode; it wins over the inherited parent value', async () => {
      await db.createNoteActionMode({ id: newUUIDv7(), tenant_id: 'uk', action_key: 'diagram', mode: 'agent' });
      expect(await db.resolveNoteActionMode('uk', 'diagram')).toBe('agent');    // own wins
      expect(await db.resolveNoteActionMode('emea', 'diagram')).toBe('direct');  // emea unchanged
    });

    it('NEGATIVE: an unknown action_key falls back to direct; unknown tenant → global', async () => {
      expect(await db.resolveNoteActionMode('uk', 'no-such-action')).toBe('direct');
      expect(await db.resolveNoteActionMode('ghost-tenant', 'diagram')).toBe('supervisor');
    });

    it('SECURITY: a hostile tenant id resolves to the global, no throw, table intact', async () => {
      expect(await db.resolveNoteActionMode(HOSTILE, 'diagram')).toBe('supervisor');
      expect((await db.listNoteActionModes()).length).toBeGreaterThan(0);
    });

    it('PURE RESOLVER: no rows → direct; null tenant picks the global row only', () => {
      const g = (mode: string): NoteActionModeRow => ({ id: 'g', tenant_id: '', action_key: 'x', mode, updated_at: '' });
      const t = (owner: string, mode: string): NoteActionModeRow => ({ id: owner, tenant_id: owner, action_key: 'x', mode, updated_at: '' });
      expect(resolveTenantEffectiveNoteActionMode([], 'x', 'uk')).toBe('direct');
      expect(resolveTenantEffectiveNoteActionMode([g('supervisor'), t('uk', 'agent')], 'x', null)).toBe('supervisor');
      // a bogus mode string normalises to direct
      expect(resolveTenantEffectiveNoteActionMode([g('nonsense')], 'x', null)).toBe('direct');
    });
  });

  // ─────────────────────────────── C9 task_type_tenant_overrides ───────────────────────────────
  describe('C9 — task_type_tenant_overrides', () => {
    const mkOverride = (tenant: string, weights: object) => db.createTaskTypeTenantOverride({
      id: newUUIDv7(), tenant_id: tenant, task_key: 'reasoning', weights: JSON.stringify(weights),
      preferred_model_id: null, preferred_provider: null, preferred_boost_pct: 20,
      cost_ceiling_per_call: null, optimisation_strategy: null, enabled: 1,
    });

    it('NULL TENANT: no global rows exist for this table → []', async () => {
      expect(await db.resolveTenantEffectiveTaskTypeOverrides(null)).toEqual([]);
    });

    it('INHERITANCE + OVERRIDE: emea sets an override; uk inherits it, then overrides it; apac sees nothing', async () => {
      await mkOverride('emea', { cost: 0.1, speed: 0.1, quality: 0.7, capability: 0.1 });
      const uk1 = await db.resolveTenantEffectiveTaskTypeOverrides('uk', 'reasoning');
      expect(uk1).toHaveLength(1);
      expect(JSON.parse(uk1[0]!.weights!).quality).toBe(0.7); // inherited from emea
      expect(uk1[0]!.tenant_id).toBe('emea');

      await mkOverride('uk', { cost: 0.5, speed: 0.2, quality: 0.2, capability: 0.1 });
      const uk2 = await db.resolveTenantEffectiveTaskTypeOverrides('uk', 'reasoning');
      expect(JSON.parse(uk2[0]!.weights!).cost).toBe(0.5); // uk's own now wins
      expect(uk2[0]!.tenant_id).toBe('uk');

      expect(await db.resolveTenantEffectiveTaskTypeOverrides('apac', 'reasoning')).toEqual([]); // sibling branch
    });

    it('SECURITY: a hostile tenant id resolves safely (no inherited match), no throw', async () => {
      expect(await db.resolveTenantEffectiveTaskTypeOverrides(HOSTILE, 'reasoning')).toEqual([]);
      expect((await db.listTaskTypeTenantOverrides()).length).toBeGreaterThan(0);
    });

    it('PURE RESOLVER: null tenant → []; a lone tenant with a self ctx resolves its own row', () => {
      const row = (owner: string): TaskTypeTenantOverrideRow => ({
        id: owner, tenant_id: owner, task_key: 'k', weights: '{}', preferred_model_id: null, preferred_provider: null,
        preferred_boost_pct: 20, cost_ceiling_per_call: null, optimisation_strategy: null, enabled: 1, created_at: '', updated_at: '' });
      expect(resolveTenantEffectiveTaskTypeOverrides([row('a')], null)).toEqual([]);
      const eff = resolveTenantEffectiveTaskTypeOverrides([row('solo')], 'solo');
      expect(eff).toHaveLength(1);
      expect(eff[0]!.tenant_id).toBe('solo');
    });
  });

  // ─────────────────────────────── C11 model_capability_scores ───────────────────────────────
  describe('C11 — model_capability_scores', () => {
    const mkScore = (tenant: string | null, quality: number, provider = 'openai', model = 'gpt-4o', task = 'reasoning') =>
      db.upsertCapabilityScore({
        id: newUUIDv7(), tenant_id: tenant, model_id: model, provider, task_key: task, quality_score: quality,
        supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 1, supports_vision: 0,
        max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1,
        last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0,
      });

    const cellQuality = (rows: ModelCapabilityScoreRow[], model = 'gpt-4o', task = 'reasoning'): number | undefined =>
      rows.find((r) => r.model_id === model && r.task_key === task)?.quality_score;

    it('NULL TENANT: returns only global rows (tenant_id IS NULL)', async () => {
      await mkScore(null, 80, 'openai', 'gpt-cscore', 'reasoning');
      const globals = await db.resolveTenantEffectiveCapabilityScores(null);
      expect(globals.length).toBeGreaterThan(0);
      expect(globals.every((r) => r.tenant_id === null || r.tenant_id === '')).toBe(true);
    });

    it('INHERITANCE + OVERRIDE: per-cell nearest-owner-wins down the lineage', async () => {
      await mkScore(null, 50, 'openai', 'gpt-cell', 'reasoning');  // global cell = 50
      await mkScore('emea', 70, 'openai', 'gpt-cell', 'reasoning'); // emea tunes it up to 70

      const uk1 = await db.resolveTenantEffectiveCapabilityScores('uk', 'reasoning');
      expect(cellQuality(uk1, 'gpt-cell')).toBe(70);              // uk inherits emea's tuned cell
      const apac = await db.resolveTenantEffectiveCapabilityScores('apac', 'reasoning');
      expect(cellQuality(apac, 'gpt-cell')).toBe(50);            // sibling branch → global

      await mkScore('uk', 90, 'openai', 'gpt-cell', 'reasoning');  // uk overrides for itself
      const uk2 = await db.resolveTenantEffectiveCapabilityScores('uk', 'reasoning');
      expect(cellQuality(uk2, 'gpt-cell')).toBe(90);            // own wins
    });

    it('ONE-PER-CELL: a tenant resolves exactly one row per (provider, model, task)', async () => {
      const rows = await db.resolveTenantEffectiveCapabilityScores('uk', 'reasoning');
      const keys = rows.map((r) => `${r.provider}::${r.model_id}::${r.task_key}`);
      expect(new Set(keys).size).toBe(keys.length);
      // no other tenant's row leaks in (only uk's own or ancestor/global)
      expect(rows.every((r) => r.tenant_id === null || ['uk', 'emea', 'acme'].includes(r.tenant_id))).toBe(true);
    });

    it('SECURITY: a hostile tenant id resolves to globals only, no throw, table intact', async () => {
      const eff = await db.resolveTenantEffectiveCapabilityScores(HOSTILE, 'reasoning');
      expect(eff.every((r) => r.tenant_id === null || r.tenant_id === '')).toBe(true);
      expect((await db.listCapabilityScores()).length).toBeGreaterThan(0);
    });

    it('PURE RESOLVER: null tenant → globals subset; unrelated tenants dropped by visibility', () => {
      const row = (tenant: string | null, model: string): ModelCapabilityScoreRow => ({
        id: `${tenant}-${model}`, tenant_id: tenant, model_id: model, provider: 'p', task_key: 'k', quality_score: 1,
        supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0, supports_vision: 0,
        max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1,
        last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0, created_at: '', updated_at: '' });
      const all = [row(null, 'm'), row('stranger', 'm')];
      expect(resolveTenantEffectiveCapabilityScores(all, null).map((r) => r.tenant_id)).toEqual([null]);
      // a tenant unrelated to 'stranger' sees only the global (stranger's row is invisible)
      const eff = resolveTenantEffectiveCapabilityScores(all, 'solo');
      expect(eff).toHaveLength(1);
      expect(eff[0]!.tenant_id).toBeNull();
    });
  });
});
