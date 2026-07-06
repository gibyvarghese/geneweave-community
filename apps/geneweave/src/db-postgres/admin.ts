// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IAdminStore` domain slice of the geneWeave `DatabaseAdapter` — the admin
 * console's policy / governance / connector / configuration surface: human-task policies, task
 * contracts, the cache subsystem (policies, settings, metrics, semantic/plan/run-stream config,
 * invalidation + tool-cache policies), identity rules, memory governance + extraction rules, search
 * providers, HTTP endpoints, social accounts, enterprise connectors, the tool registry, replay
 * scenarios, trigger definitions, tenant configs, sandbox policies, extraction pipelines, artifact /
 * reliability policies, collaboration sessions, compliance rules, graph + plugin configs, the
 * developer-experience configs (scaffold templates, recipes, widgets, validation rules), and the big
 * `seedDefaultData` bootstrap.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same return shapes. SQLite-isms are translated per the porting convention —
 * `?`→`$n` placeholders (dynamic SET/WHERE builders renumber via `$${vals.length + 1}`),
 * `datetime('now')`→`${ctx.now}`, `strftime('%Y-%m-%dT%H:%M:%fZ','now')`→ISO-ms text, text
 * `ORDER BY <textCol>`→append `COLLATE "C"` (byte order; NOT on numeric/priority columns),
 * `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, and `INSERT … ON CONFLICT (cols) DO UPDATE` for
 * upserts. Booleans persist as INTEGER 0/1 (numbers); JSON columns are TEXT pass-through; every value
 * is a bound parameter. Credential columns reuse the same fail-open vault shadow-column encryption the
 * SQLite adapter uses (plaintext + `credentials_encrypted = 0` until a `VAULT_KEY` is provisioned).
 */
import { newUUIDv7 } from '@weaveintel/core';
import { stringifyPromptVariables } from '@weaveintel/prompts';
import { BUILT_IN_SKILLS } from '@weaveintel/skills';
import { encryptCredential, decryptCredential } from '../vault.js';
import { HARD_EXECUTION_GUARD_POLICY, SUPERVISOR_CODE_EXECUTION_POLICY } from '../chat-policies.js';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  HumanTaskPolicyRow,
  TaskContractRow,
  CachePolicyRow,
  CacheSettingsRow,
  CacheMetricsDelta,
  CacheMetricsRow,
  CacheMetricsSummary,
  SemanticCacheConfigRow,
  RunStreamConfigRow,
  AgentPlanCacheConfigRow,
  CacheInvalidationRuleRow,
  ToolCachePolicyRow,
  IdentityRuleRow,
  MemoryGovernanceRow,
  MemoryExtractionRuleRow,
  SearchProviderRow,
  HttpEndpointRow,
  SocialAccountRow,
  EnterpriseConnectorRow,
  ReplayScenarioRow,
  TriggerDefinitionRow,
  TenantConfigRow,
  SandboxPolicyRow,
  ExtractionPipelineRow,
  ArtifactPolicyRow,
  ReliabilityPolicyRow,
  CollaborationSessionRow,
  ComplianceRuleRow,
  GraphConfigRow,
  PluginConfigRow,
} from '../db-types/admin.js';
import type { ToolRegistryRow } from '../db-types/tools.js';
import type {
  ScaffoldTemplateRow,
  RecipeConfigRow,
  WidgetConfigRow,
  ValidationRuleRow,
} from '../db-types/dev-experience.js';
import type {
  PromptRow,
  PromptFrameworkRow,
  PromptFragmentRow,
  PromptStrategyRow,
  PromptOptimizerRow,
} from '../db-types/prompts.js';
import type { GuardrailRow, RoutingPolicyRow } from '../db-types/routing.js';
import type { WorkflowDefRow } from '../db-types/workflows.js';
import type { ToolCatalogRow } from '../db-types/tools.js';
import type { WorkerAgentRow } from '../db-types/agents.js';

// ── Vault helpers for m49 shadow-column encryption ───────────────────────────
// Fail-open: if VAULT_KEY is absent the server still boots; callers store
// plaintext with credentials_encrypted = 0 until a key is provisioned. Mirrors
// the SQLiteAdapter helpers of the same name.
function vaultEncryptField(value: string | null): string | null {
  if (!value || !process.env['VAULT_KEY']) return null;
  try { return encryptCredential(value).encrypted; } catch { return null; }
}
function vaultDecryptField(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try { return decryptCredential<string>(ciphertext); } catch { return null; }
}

/** ISO-8601-with-millis UTC text, matching SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. */
const NOW_ISO_MS = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Hourly bucket text, matching SQLite `strftime('%Y-%m-%dT%H:00:00Z','now')`. */
const NOW_HOUR_BUCKET = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24":00:00Z"')`;

export function pgAdminStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Human Task Policies ───────────────────────────────────────────────────
    async createHumanTaskPolicy(p: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO human_task_policies (id, name, description, trigger, task_type, default_priority, sla_hours, auto_escalate_after_hours, assignment_strategy, assign_to, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [p.id, p.name, p.description ?? null, p.trigger, p.task_type, p.default_priority, p.sla_hours ?? null, p.auto_escalate_after_hours ?? null, p.assignment_strategy, p.assign_to ?? null, p.enabled],
      );
    },

    async getHumanTaskPolicy(id: string): Promise<HumanTaskPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM human_task_policies WHERE id = $1', [id]);
      return (rows[0] as HumanTaskPolicyRow | undefined) ?? null;
    },

    async listHumanTaskPolicies(): Promise<HumanTaskPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM human_task_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as HumanTaskPolicyRow[];
    },

    async updateHumanTaskPolicy(id: string, fields: Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE human_task_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteHumanTaskPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM human_task_policies WHERE id = $1', [id]);
    },

    // ─── Task Contracts ────────────────────────────────────────────────────────
    async createTaskContract(c: Omit<TaskContractRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO task_contracts (id, name, description, input_schema, output_schema, acceptance_criteria, max_attempts, timeout_ms, evidence_required, min_confidence, require_human_review, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [c.id, c.name, c.description ?? null, c.input_schema ?? null, c.output_schema ?? null, c.acceptance_criteria, c.max_attempts ?? null, c.timeout_ms ?? null, c.evidence_required ?? null, c.min_confidence ?? null, c.require_human_review, c.enabled],
      );
    },

    async getTaskContract(id: string): Promise<TaskContractRow | null> {
      const { rows } = await ctx.query('SELECT * FROM task_contracts WHERE id = $1', [id]);
      return (rows[0] as TaskContractRow | undefined) ?? null;
    },

    async listTaskContracts(): Promise<TaskContractRow[]> {
      const { rows } = await ctx.query('SELECT * FROM task_contracts ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as TaskContractRow[];
    },

    async updateTaskContract(id: string, fields: Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE task_contracts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteTaskContract(id: string): Promise<void> {
      await ctx.query('DELETE FROM task_contracts WHERE id = $1', [id]);
    },

    // ─── Cache Policies ────────────────────────────────────────────────────────
    async createCachePolicy(p: Omit<CachePolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO cache_policies (id, name, description, scope, ttl_ms, max_entries, max_bytes, bypass_patterns, output_bypass_patterns, invalidate_on, key_hashing, tenant_isolation, cache_temperature_gate, swr_ms, negative_ttl_ms, eviction_policy, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          p.id, p.name, p.description ?? null, p.scope, p.ttl_ms, p.max_entries,
          p.max_bytes ?? 0, p.bypass_patterns ?? null, p.output_bypass_patterns ?? null,
          p.invalidate_on ?? null, p.key_hashing ?? 'sha256',
          p.tenant_isolation ?? 1, p.cache_temperature_gate ?? 0,
          p.swr_ms ?? 0, p.negative_ttl_ms ?? 0, p.eviction_policy ?? 'lru', p.enabled,
        ],
      );
    },

    async getCachePolicy(id: string): Promise<CachePolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM cache_policies WHERE id = $1', [id]);
      return (rows[0] as CachePolicyRow | undefined) ?? null;
    },

    async listCachePolicies(): Promise<CachePolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM cache_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as CachePolicyRow[];
    },

    async updateCachePolicy(id: string, fields: Partial<Omit<CachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE cache_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCachePolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM cache_policies WHERE id = $1', [id]);
    },

    // ─── Cache Settings (single global row) ────────────────────────────────────
    async getCacheSettings(): Promise<CacheSettingsRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM cache_settings WHERE id = 'global'`, []);
      return (rows[0] as CacheSettingsRow | undefined) ?? null;
    },

    async updateCacheSettings(fields: Partial<Omit<CacheSettingsRow, 'id' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      // Upsert: ensure the single global row exists, then patch it.
      await ctx.query(`INSERT INTO cache_settings (id) VALUES ('global') ON CONFLICT DO NOTHING`, []);
      await ctx.query(`UPDATE cache_settings SET ${sets.join(', ')} WHERE id = 'global'`, vals);
    },

    // ─── Cache Invalidation Rules (Phase 5) ────────────────────────────────────
    async createCacheInvalidationRule(r: Omit<CacheInvalidationRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO cache_invalidation_rules (id, name, trigger, pattern, config, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.id, r.name, r.trigger, r.pattern ?? null, r.config ?? null, r.enabled],
      );
    },

    async getCacheInvalidationRule(id: string): Promise<CacheInvalidationRuleRow | null> {
      const { rows } = await ctx.query('SELECT * FROM cache_invalidation_rules WHERE id = $1', [id]);
      return (rows[0] as CacheInvalidationRuleRow | undefined) ?? null;
    },

    async listCacheInvalidationRules(): Promise<CacheInvalidationRuleRow[]> {
      const { rows } = await ctx.query('SELECT * FROM cache_invalidation_rules ORDER BY trigger COLLATE "C" ASC, name COLLATE "C" ASC', []);
      return rows as unknown as CacheInvalidationRuleRow[];
    },

    async updateCacheInvalidationRule(id: string, fields: Partial<Omit<CacheInvalidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE cache_invalidation_rules SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCacheInvalidationRule(id: string): Promise<void> {
      await ctx.query('DELETE FROM cache_invalidation_rules WHERE id = $1', [id]);
    },

    // ── Tool Cache Policies (Phase 6 opt-in tool-result caching) ──────────────
    async createToolCachePolicy(r: Omit<ToolCachePolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_cache_policies (id, tool_name, cacheable, ttl_ms, enabled) VALUES ($1, $2, $3, $4, $5)`,
        [r.id, r.tool_name, r.cacheable, r.ttl_ms, r.enabled],
      );
    },

    async getToolCachePolicy(id: string): Promise<ToolCachePolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_cache_policies WHERE id = $1', [id]);
      return (rows[0] as ToolCachePolicyRow | undefined) ?? null;
    },

    async listToolCachePolicies(): Promise<ToolCachePolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_cache_policies ORDER BY tool_name COLLATE "C" ASC', []);
      return rows as unknown as ToolCachePolicyRow[];
    },

    async updateToolCachePolicy(id: string, fields: Partial<Omit<ToolCachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tool_cache_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteToolCachePolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM tool_cache_policies WHERE id = $1', [id]);
    },

    // ─── Semantic Cache Config (single global row) ─────────────────────────────
    async getSemanticCacheConfig(): Promise<SemanticCacheConfigRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM semantic_cache_config WHERE id = 'global'`, []);
      return (rows[0] as SemanticCacheConfigRow | undefined) ?? null;
    },

    async updateSemanticCacheConfig(fields: Partial<Omit<SemanticCacheConfigRow, 'id' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      await ctx.query(`INSERT INTO semantic_cache_config (id) VALUES ('global') ON CONFLICT DO NOTHING`, []);
      await ctx.query(`UPDATE semantic_cache_config SET ${sets.join(', ')} WHERE id = 'global'`, vals);
    },

    // ── Run Stream Config (Client Phase 0 single global row) ───────────────────
    async getRunStreamConfig(): Promise<RunStreamConfigRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM run_stream_config WHERE id = 'global'`, []);
      return (rows[0] as RunStreamConfigRow | undefined) ?? null;
    },

    async updateRunStreamConfig(fields: Partial<Omit<RunStreamConfigRow, 'id' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      await ctx.query(`INSERT INTO run_stream_config (id) VALUES ('global') ON CONFLICT DO NOTHING`, []);
      await ctx.query(`UPDATE run_stream_config SET ${sets.join(', ')} WHERE id = 'global'`, vals);
    },

    // ── Agent Plan Cache Config (Phase 8 single global row) ────────────────────
    async getAgentPlanCacheConfig(): Promise<AgentPlanCacheConfigRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM agent_plan_cache_config WHERE id = 'global'`, []);
      return (rows[0] as AgentPlanCacheConfigRow | undefined) ?? null;
    },

    async updateAgentPlanCacheConfig(fields: Partial<Omit<AgentPlanCacheConfigRow, 'id' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      await ctx.query(`INSERT INTO agent_plan_cache_config (id) VALUES ('global') ON CONFLICT DO NOTHING`, []);
      await ctx.query(`UPDATE agent_plan_cache_config SET ${sets.join(', ')} WHERE id = 'global'`, vals);
    },

    // ─── Cache Metrics (Phase 3 observability rollup) ──────────────────────────
    async recordCacheMetrics(delta: CacheMetricsDelta): Promise<void> {
      const hits = Math.max(0, Math.trunc(delta.responseHits ?? 0));
      const misses = Math.max(0, Math.trunc(delta.responseMisses ?? 0));
      const readTok = Math.max(0, Math.trunc(delta.promptCacheReadTokens ?? 0));
      const writeTok = Math.max(0, Math.trunc(delta.promptCacheWriteTokens ?? 0));
      const saved = Math.max(0, Number(delta.costSavedUsd ?? 0)) || 0;
      if (!hits && !misses && !readTok && !writeTok && !saved) return;
      await ctx.query(
        `INSERT INTO cache_metrics (window_start, response_hits, response_misses, prompt_cache_read_tokens, prompt_cache_write_tokens, cost_saved_usd, updated_at)
         VALUES (${NOW_HOUR_BUCKET}, $1, $2, $3, $4, $5, ${ctx.now})
         ON CONFLICT(window_start) DO UPDATE SET
           response_hits = cache_metrics.response_hits + excluded.response_hits,
           response_misses = cache_metrics.response_misses + excluded.response_misses,
           prompt_cache_read_tokens = cache_metrics.prompt_cache_read_tokens + excluded.prompt_cache_read_tokens,
           prompt_cache_write_tokens = cache_metrics.prompt_cache_write_tokens + excluded.prompt_cache_write_tokens,
           cost_saved_usd = cache_metrics.cost_saved_usd + excluded.cost_saved_usd,
           updated_at = ${ctx.now}`,
        [hits, misses, readTok, writeTok, saved],
      );
    },

    async getCacheMetrics(limit = 168): Promise<CacheMetricsSummary> {
      const { rows: windows } = await ctx.query(
        `SELECT * FROM cache_metrics ORDER BY window_start DESC LIMIT $1`,
        [Math.max(1, Math.min(1000, limit))],
      );
      const { rows: aggRows } = await ctx.query(
        `SELECT
           COALESCE(SUM(response_hits),0) AS h,
           COALESCE(SUM(response_misses),0) AS m,
           COALESCE(SUM(prompt_cache_read_tokens),0) AS rt,
           COALESCE(SUM(prompt_cache_write_tokens),0) AS wt,
           COALESCE(SUM(cost_saved_usd),0) AS cs
         FROM cache_metrics`,
        [],
      );
      const agg = aggRows[0] as { h: number; m: number; rt: number; wt: number; cs: number };
      const lookups = agg.h + agg.m;
      return {
        totals: {
          responseHits: agg.h,
          responseMisses: agg.m,
          hitRate: lookups > 0 ? agg.h / lookups : 0,
          promptCacheReadTokens: agg.rt,
          promptCacheWriteTokens: agg.wt,
          costSavedUsd: agg.cs,
        },
        windows: windows as unknown as CacheMetricsRow[],
      };
    },

    // ─── Identity Rules ────────────────────────────────────────────────────────
    async createIdentityRule(r: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO identity_rules (id, name, description, resource, action, roles, scopes, result, priority, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.id, r.name, r.description ?? null, r.resource, r.action, r.roles ?? null, r.scopes ?? null, r.result, r.priority, r.enabled],
      );
    },

    async getIdentityRule(id: string): Promise<IdentityRuleRow | null> {
      const { rows } = await ctx.query('SELECT * FROM identity_rules WHERE id = $1', [id]);
      return (rows[0] as IdentityRuleRow | undefined) ?? null;
    },

    async listIdentityRules(): Promise<IdentityRuleRow[]> {
      const { rows } = await ctx.query('SELECT * FROM identity_rules ORDER BY priority DESC, name COLLATE "C" ASC', []);
      return rows as unknown as IdentityRuleRow[];
    },

    async updateIdentityRule(id: string, fields: Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE identity_rules SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteIdentityRule(id: string): Promise<void> {
      await ctx.query('DELETE FROM identity_rules WHERE id = $1', [id]);
    },

    // ─── Memory Governance ─────────────────────────────────────────────────────
    async createMemoryGovernance(g: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO memory_governance (id, name, description, memory_types, tenant_id, block_patterns, redact_patterns, max_age, max_entries, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [g.id, g.name, g.description ?? null, g.memory_types ?? null, g.tenant_id ?? null, g.block_patterns ?? null, g.redact_patterns ?? null, g.max_age ?? null, g.max_entries ?? null, g.enabled],
      );
    },

    async getMemoryGovernance(id: string): Promise<MemoryGovernanceRow | null> {
      const { rows } = await ctx.query('SELECT * FROM memory_governance WHERE id = $1', [id]);
      return (rows[0] as MemoryGovernanceRow | undefined) ?? null;
    },

    async listMemoryGovernance(): Promise<MemoryGovernanceRow[]> {
      const { rows } = await ctx.query('SELECT * FROM memory_governance ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as MemoryGovernanceRow[];
    },

    async updateMemoryGovernance(id: string, fields: Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE memory_governance SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteMemoryGovernance(id: string): Promise<void> {
      await ctx.query('DELETE FROM memory_governance WHERE id = $1', [id]);
    },

    // ─── Memory Extraction Rules ───────────────────────────────────────────────
    async createMemoryExtractionRule(r: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO memory_extraction_rules (id, name, description, rule_type, entity_type, pattern, flags, facts_template, priority, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.id, r.name, r.description ?? null, r.rule_type, r.entity_type ?? null, r.pattern, r.flags ?? null, r.facts_template ?? null, r.priority, r.enabled],
      );
    },

    async getMemoryExtractionRule(id: string): Promise<MemoryExtractionRuleRow | null> {
      const { rows } = await ctx.query('SELECT * FROM memory_extraction_rules WHERE id = $1', [id]);
      return (rows[0] as MemoryExtractionRuleRow | undefined) ?? null;
    },

    async listMemoryExtractionRules(ruleType?: string): Promise<MemoryExtractionRuleRow[]> {
      if (ruleType) {
        const { rows } = await ctx.query('SELECT * FROM memory_extraction_rules WHERE rule_type = $1 ORDER BY priority DESC, name COLLATE "C" ASC', [ruleType]);
        return rows as unknown as MemoryExtractionRuleRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM memory_extraction_rules ORDER BY rule_type COLLATE "C" ASC, priority DESC, name COLLATE "C" ASC', []);
      return rows as unknown as MemoryExtractionRuleRow[];
    },

    async updateMemoryExtractionRule(id: string, fields: Partial<Omit<MemoryExtractionRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE memory_extraction_rules SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteMemoryExtractionRule(id: string): Promise<void> {
      await ctx.query('DELETE FROM memory_extraction_rules WHERE id = $1', [id]);
    },

    // ─── Search Providers (vault shadow-column encryption) ─────────────────────
    async createSearchProvider(p: Omit<SearchProviderRow, 'created_at' | 'updated_at'>): Promise<void> {
      const enc = vaultEncryptField(p.api_key ?? null);
      const credFlag = enc !== null ? 1 : 0;
      await ctx.query(
        `INSERT INTO search_providers (id, name, description, provider_type, api_key, api_key_enc, credentials_encrypted, base_url, priority, options, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [p.id, p.name, p.description ?? null, p.provider_type, credFlag ? null : (p.api_key ?? null), enc, credFlag, p.base_url ?? null, p.priority, p.options ?? null, p.enabled],
      );
    },

    async getSearchProvider(id: string): Promise<SearchProviderRow | null> {
      type Raw = SearchProviderRow & { api_key_enc?: string | null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM search_providers WHERE id = $1', [id]);
      const raw = rows[0] as Raw | undefined;
      if (!raw) return null;
      return raw.credentials_encrypted === 1 ? { ...raw, api_key: vaultDecryptField(raw.api_key_enc ?? null) } : raw;
    },

    async listSearchProviders(): Promise<SearchProviderRow[]> {
      type Raw = SearchProviderRow & { api_key_enc?: string | null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM search_providers ORDER BY priority DESC, name COLLATE "C" ASC', []);
      return (rows as unknown as Raw[]).map(
        r => r.credentials_encrypted === 1 ? { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null) } : r,
      );
    },

    async updateSearchProvider(id: string, fields: Partial<Omit<SearchProviderRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const ALLOWED = new Set(['name', 'description', 'provider_type', 'base_url', 'priority', 'options', 'enabled']);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'api_key') {
          const enc = vaultEncryptField(typeof v === 'string' ? v : null);
          if (enc !== null) {
            sets.push(`api_key = $${vals.length + 1}`); vals.push(null);
            sets.push(`api_key_enc = $${vals.length + 1}`); vals.push(enc);
            sets.push('credentials_encrypted = 1');
          } else {
            sets.push(`api_key = $${vals.length + 1}`); vals.push(v ?? null);
          }
        } else if (ALLOWED.has(k)) {
          sets.push(`${k} = $${vals.length + 1}`); vals.push(v);
        }
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE search_providers SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteSearchProvider(id: string): Promise<void> {
      await ctx.query('DELETE FROM search_providers WHERE id = $1', [id]);
    },

    // ─── HTTP Endpoints ────────────────────────────────────────────────────────
    async createHttpEndpoint(e: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO http_endpoints (id, name, description, url, method, auth_type, auth_config, headers, body_template, response_transform, retry_count, rate_limit_rpm, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [e.id, e.name, e.description ?? null, e.url, e.method, e.auth_type ?? null, e.auth_config ?? null, e.headers ?? null, e.body_template ?? null, e.response_transform ?? null, e.retry_count, e.rate_limit_rpm ?? null, e.enabled],
      );
    },

    async getHttpEndpoint(id: string): Promise<HttpEndpointRow | null> {
      const { rows } = await ctx.query('SELECT * FROM http_endpoints WHERE id = $1', [id]);
      return (rows[0] as HttpEndpointRow | undefined) ?? null;
    },

    async listHttpEndpoints(): Promise<HttpEndpointRow[]> {
      const { rows } = await ctx.query('SELECT * FROM http_endpoints ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as HttpEndpointRow[];
    },

    async updateHttpEndpoint(id: string, fields: Partial<Omit<HttpEndpointRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE http_endpoints SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteHttpEndpoint(id: string): Promise<void> {
      await ctx.query('DELETE FROM http_endpoints WHERE id = $1', [id]);
    },

    // ─── Social Accounts (vault shadow-column encryption) ──────────────────────
    async createSocialAccount(a: Omit<SocialAccountRow, 'created_at' | 'updated_at'>): Promise<void> {
      const encKey    = vaultEncryptField(a.api_key ?? null);
      const encSecret = vaultEncryptField(a.api_secret ?? null);
      const encAccess = vaultEncryptField(a.access_token ?? null);
      const encRefresh = vaultEncryptField(a.refresh_token ?? null);
      const credFlag  = (encKey ?? encSecret ?? encAccess ?? encRefresh) !== null ? 1 : 0;
      await ctx.query(
        `INSERT INTO social_accounts (id, name, description, platform, api_key, api_key_enc, api_secret, api_secret_enc, access_token, access_token_enc, refresh_token, refresh_token_enc, credentials_encrypted, token_expires_at, oauth_state, status, base_url, options, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          a.id, a.name, a.description ?? null, a.platform,
          credFlag ? null : (a.api_key ?? null),    encKey,
          credFlag ? null : (a.api_secret ?? null),  encSecret,
          credFlag ? null : (a.access_token ?? null), encAccess,
          credFlag ? null : (a.refresh_token ?? null), encRefresh,
          credFlag,
          a.token_expires_at ?? null, a.oauth_state ?? null, a.status ?? 'disconnected', a.base_url ?? null, a.options ?? null, a.enabled,
        ],
      );
    },

    async getSocialAccount(id: string): Promise<SocialAccountRow | null> {
      type Raw = SocialAccountRow & { api_key_enc?: string|null; api_secret_enc?: string|null; access_token_enc?: string|null; refresh_token_enc?: string|null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM social_accounts WHERE id = $1', [id]);
      const r = rows[0] as Raw | undefined;
      if (!r) return null;
      if (r.credentials_encrypted !== 1) return r;
      return { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null), api_secret: vaultDecryptField(r.api_secret_enc ?? null), access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null) };
    },

    async listSocialAccounts(): Promise<SocialAccountRow[]> {
      type Raw = SocialAccountRow & { api_key_enc?: string|null; api_secret_enc?: string|null; access_token_enc?: string|null; refresh_token_enc?: string|null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM social_accounts ORDER BY name COLLATE "C" ASC', []);
      return (rows as unknown as Raw[]).map(r =>
        r.credentials_encrypted !== 1 ? r : { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null), api_secret: vaultDecryptField(r.api_secret_enc ?? null), access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null) },
      );
    },

    async updateSocialAccount(id: string, fields: Partial<Omit<SocialAccountRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const SENSITIVE = new Set(['api_key', 'api_secret', 'access_token', 'refresh_token']);
      const SENSITIVE_MAP: Record<string, string> = { api_key: 'api_key_enc', api_secret: 'api_secret_enc', access_token: 'access_token_enc', refresh_token: 'refresh_token_enc' };
      const ALLOWED = new Set(['name', 'description', 'platform', 'token_expires_at', 'oauth_state', 'status', 'base_url', 'options', 'enabled']);
      const sets: string[] = [];
      const vals: unknown[] = [];
      let anyEncrypted = false;
      for (const [k, v] of Object.entries(fields)) {
        if (SENSITIVE.has(k)) {
          const enc = vaultEncryptField(typeof v === 'string' ? v : null);
          if (enc !== null) {
            sets.push(`${k} = $${vals.length + 1}`); vals.push(null);
            sets.push(`${SENSITIVE_MAP[k]} = $${vals.length + 1}`); vals.push(enc);
            anyEncrypted = true;
          } else {
            sets.push(`${k} = $${vals.length + 1}`); vals.push(v ?? null);
          }
        } else if (ALLOWED.has(k)) {
          sets.push(`${k} = $${vals.length + 1}`); vals.push(v);
        }
      }
      if (anyEncrypted) { sets.push('credentials_encrypted = 1'); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE social_accounts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteSocialAccount(id: string): Promise<void> {
      await ctx.query('DELETE FROM social_accounts WHERE id = $1', [id]);
    },

    // ─── Enterprise Connectors (vault shadow-column encryption) ────────────────
    async createEnterpriseConnector(c: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>): Promise<void> {
      const encAccess  = vaultEncryptField(c.access_token ?? null);
      const encRefresh = vaultEncryptField(c.refresh_token ?? null);
      const encAuth    = vaultEncryptField(c.auth_config ?? null);
      const credFlag   = (encAccess ?? encRefresh ?? encAuth) !== null ? 1 : 0;
      await ctx.query(
        `INSERT INTO enterprise_connectors (id, name, description, connector_type, base_url, auth_type, auth_config, auth_config_enc, access_token, access_token_enc, refresh_token, refresh_token_enc, credentials_encrypted, token_expires_at, oauth_state, status, options, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          c.id, c.name, c.description ?? null, c.connector_type, c.base_url ?? null, c.auth_type ?? null,
          credFlag ? null : (c.auth_config ?? null),    encAuth,
          credFlag ? null : (c.access_token ?? null),   encAccess,
          credFlag ? null : (c.refresh_token ?? null),  encRefresh,
          credFlag,
          c.token_expires_at ?? null, c.oauth_state ?? null, c.status ?? 'disconnected', c.options ?? null, c.enabled,
        ],
      );
    },

    async getEnterpriseConnector(id: string): Promise<EnterpriseConnectorRow | null> {
      type Raw = EnterpriseConnectorRow & { access_token_enc?: string|null; refresh_token_enc?: string|null; auth_config_enc?: string|null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM enterprise_connectors WHERE id = $1', [id]);
      const r = rows[0] as Raw | undefined;
      if (!r) return null;
      if (r.credentials_encrypted !== 1) return r;
      return { ...r, access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null), auth_config: vaultDecryptField(r.auth_config_enc ?? null) };
    },

    async listEnterpriseConnectors(): Promise<EnterpriseConnectorRow[]> {
      type Raw = EnterpriseConnectorRow & { access_token_enc?: string|null; refresh_token_enc?: string|null; auth_config_enc?: string|null; credentials_encrypted?: number };
      const { rows } = await ctx.query('SELECT * FROM enterprise_connectors ORDER BY name COLLATE "C" ASC', []);
      return (rows as unknown as Raw[]).map(r =>
        r.credentials_encrypted !== 1 ? r : { ...r, access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null), auth_config: vaultDecryptField(r.auth_config_enc ?? null) },
      );
    },

    async updateEnterpriseConnector(id: string, fields: Partial<Omit<EnterpriseConnectorRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const SENSITIVE_MAP: Record<string, string> = { access_token: 'access_token_enc', refresh_token: 'refresh_token_enc', auth_config: 'auth_config_enc' };
      const ALLOWED = new Set(['name', 'description', 'connector_type', 'base_url', 'auth_type', 'token_expires_at', 'oauth_state', 'status', 'options', 'enabled']);
      const sets: string[] = [];
      const vals: unknown[] = [];
      let anyEncrypted = false;
      for (const [k, v] of Object.entries(fields)) {
        if (k in SENSITIVE_MAP) {
          const enc = vaultEncryptField(typeof v === 'string' ? v : null);
          if (enc !== null) {
            sets.push(`${k} = $${vals.length + 1}`); vals.push(null);
            sets.push(`${SENSITIVE_MAP[k]} = $${vals.length + 1}`); vals.push(enc);
            anyEncrypted = true;
          } else {
            sets.push(`${k} = $${vals.length + 1}`); vals.push(v ?? null);
          }
        } else if (ALLOWED.has(k)) {
          sets.push(`${k} = $${vals.length + 1}`); vals.push(v);
        }
      }
      if (anyEncrypted) { sets.push('credentials_encrypted = 1'); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE enterprise_connectors SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteEnterpriseConnector(id: string): Promise<void> {
      await ctx.query('DELETE FROM enterprise_connectors WHERE id = $1', [id]);
    },

    // ─── Tool Registry ─────────────────────────────────────────────────────────
    async createToolRegistryEntry(t: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_registry (id, name, description, package_name, version, category, risk_level, tags, config, requires_approval, max_execution_ms, rate_limit_per_min, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [t.id, t.name, t.description ?? null, t.package_name, t.version, t.category, t.risk_level, t.tags ?? null, t.config ?? null, t.requires_approval, t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled],
      );
    },

    async getToolRegistryEntry(id: string): Promise<ToolRegistryRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_registry WHERE id = $1', [id]);
      return (rows[0] as ToolRegistryRow | undefined) ?? null;
    },

    async listToolRegistry(): Promise<ToolRegistryRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_registry ORDER BY category COLLATE "C" ASC, name COLLATE "C" ASC', []);
      return rows as unknown as ToolRegistryRow[];
    },

    async updateToolRegistryEntry(id: string, fields: Partial<Omit<ToolRegistryRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tool_registry SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteToolRegistryEntry(id: string): Promise<void> {
      await ctx.query('DELETE FROM tool_registry WHERE id = $1', [id]);
    },

    // ─── Replay Scenarios ──────────────────────────────────────────────────────
    async createReplayScenario(s: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO replay_scenarios (id, name, description, golden_prompt, golden_response, model, provider, tags, acceptance_criteria, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [s.id, s.name, s.description ?? null, s.golden_prompt, s.golden_response, s.model ?? null, s.provider ?? null, s.tags ?? null, s.acceptance_criteria ?? null, s.enabled],
      );
    },

    async getReplayScenario(id: string): Promise<ReplayScenarioRow | null> {
      const { rows } = await ctx.query('SELECT * FROM replay_scenarios WHERE id = $1', [id]);
      return (rows[0] as ReplayScenarioRow | undefined) ?? null;
    },

    async listReplayScenarios(): Promise<ReplayScenarioRow[]> {
      const { rows } = await ctx.query('SELECT * FROM replay_scenarios ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ReplayScenarioRow[];
    },

    async updateReplayScenario(id: string, fields: Partial<Omit<ReplayScenarioRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE replay_scenarios SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteReplayScenario(id: string): Promise<void> {
      await ctx.query('DELETE FROM replay_scenarios WHERE id = $1', [id]);
    },

    // ─── Trigger Definitions ───────────────────────────────────────────────────
    async createTriggerDefinition(t: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO trigger_definitions (id, name, description, trigger_type, expression, config, target_workflow, status, last_fired_at, fire_count, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [t.id, t.name, t.description ?? null, t.trigger_type, t.expression ?? null, t.config ?? null, t.target_workflow ?? null, t.status, t.last_fired_at ?? null, t.fire_count, t.enabled],
      );
    },

    async getTriggerDefinition(id: string): Promise<TriggerDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM trigger_definitions WHERE id = $1', [id]);
      return (rows[0] as TriggerDefinitionRow | undefined) ?? null;
    },

    async listTriggerDefinitions(): Promise<TriggerDefinitionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM trigger_definitions ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as TriggerDefinitionRow[];
    },

    async updateTriggerDefinition(id: string, fields: Partial<Omit<TriggerDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE trigger_definitions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteTriggerDefinition(id: string): Promise<void> {
      await ctx.query('DELETE FROM trigger_definitions WHERE id = $1', [id]);
    },

    // ─── Tenant Configs ────────────────────────────────────────────────────────
    async createTenantConfig(c: Omit<TenantConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_configs (id, name, description, tenant_id, scope, allowed_models, denied_models, allowed_tools, max_tokens_daily, max_cost_daily, max_tokens_monthly, max_cost_monthly, features, config_overrides, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [c.id, c.name, c.description ?? null, c.tenant_id, c.scope, c.allowed_models ?? null, c.denied_models ?? null, c.allowed_tools ?? null, c.max_tokens_daily ?? null, c.max_cost_daily ?? null, c.max_tokens_monthly ?? null, c.max_cost_monthly ?? null, c.features ?? null, c.config_overrides ?? null, c.enabled],
      );
    },

    async getTenantConfig(id: string): Promise<TenantConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_configs WHERE id = $1', [id]);
      return (rows[0] as TenantConfigRow | undefined) ?? null;
    },

    async getGlobalTenantConfig(): Promise<TenantConfigRow | null> {
      const { rows } = await ctx.query("SELECT * FROM tenant_configs WHERE scope = 'global' ORDER BY created_at COLLATE \"C\" ASC LIMIT 1", []);
      return (rows[0] as TenantConfigRow | undefined) ?? null;
    },

    async getTenantConfigForTenant(tenantId: string): Promise<TenantConfigRow | null> {
      const { rows } = await ctx.query("SELECT * FROM tenant_configs WHERE tenant_id = $1 AND scope != 'global' AND enabled = 1 ORDER BY created_at COLLATE \"C\" ASC LIMIT 1", [tenantId]);
      return (rows[0] as TenantConfigRow | undefined) ?? null;
    },

    async listTenantConfigs(): Promise<TenantConfigRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_configs ORDER BY tenant_id COLLATE "C" ASC, name COLLATE "C" ASC', []);
      return rows as unknown as TenantConfigRow[];
    },

    async updateTenantConfig(id: string, fields: Partial<Omit<TenantConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteTenantConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM tenant_configs WHERE id = $1', [id]);
    },

    // ─── Sandbox Policies ──────────────────────────────────────────────────────
    async createSandboxPolicy(p: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO sandbox_policies (id, name, description, max_cpu_ms, max_memory_mb, max_duration_ms, max_output_bytes, allowed_modules, denied_modules, network_access, filesystem_access, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.id, p.name, p.description ?? null, p.max_cpu_ms ?? null, p.max_memory_mb ?? null, p.max_duration_ms, p.max_output_bytes ?? null, p.allowed_modules ?? null, p.denied_modules ?? null, p.network_access, p.filesystem_access, p.enabled],
      );
    },

    async getSandboxPolicy(id: string): Promise<SandboxPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM sandbox_policies WHERE id = $1', [id]);
      return (rows[0] as SandboxPolicyRow | undefined) ?? null;
    },

    async listSandboxPolicies(): Promise<SandboxPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM sandbox_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as SandboxPolicyRow[];
    },

    async updateSandboxPolicy(id: string, fields: Partial<Omit<SandboxPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE sandbox_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteSandboxPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM sandbox_policies WHERE id = $1', [id]);
    },

    // ─── Extraction Pipelines ──────────────────────────────────────────────────
    async createExtractionPipeline(p: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO extraction_pipelines (id, name, description, stages, input_mime_types, max_input_size_bytes, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, p.name, p.description ?? null, p.stages, p.input_mime_types ?? null, p.max_input_size_bytes ?? null, p.enabled],
      );
    },

    async getExtractionPipeline(id: string): Promise<ExtractionPipelineRow | null> {
      const { rows } = await ctx.query('SELECT * FROM extraction_pipelines WHERE id = $1', [id]);
      return (rows[0] as ExtractionPipelineRow | undefined) ?? null;
    },

    async listExtractionPipelines(): Promise<ExtractionPipelineRow[]> {
      const { rows } = await ctx.query('SELECT * FROM extraction_pipelines ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ExtractionPipelineRow[];
    },

    async updateExtractionPipeline(id: string, fields: Partial<Omit<ExtractionPipelineRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE extraction_pipelines SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteExtractionPipeline(id: string): Promise<void> {
      await ctx.query('DELETE FROM extraction_pipelines WHERE id = $1', [id]);
    },

    // ─── Artifact Policies ─────────────────────────────────────────────────────
    async createArtifactPolicy(p: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO artifact_policies (id, name, description, max_size_bytes, allowed_types, retention_days, require_versioning, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.id, p.name, p.description ?? null, p.max_size_bytes ?? null, p.allowed_types ?? null, p.retention_days ?? null, p.require_versioning, p.enabled],
      );
    },

    async getArtifactPolicy(id: string): Promise<ArtifactPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM artifact_policies WHERE id = $1', [id]);
      return (rows[0] as ArtifactPolicyRow | undefined) ?? null;
    },

    async listArtifactPolicies(): Promise<ArtifactPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM artifact_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ArtifactPolicyRow[];
    },

    async updateArtifactPolicy(id: string, fields: Partial<Omit<ArtifactPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE artifact_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteArtifactPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM artifact_policies WHERE id = $1', [id]);
    },

    // ─── Reliability Policies ──────────────────────────────────────────────────
    async createReliabilityPolicy(p: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO reliability_policies (id, name, description, policy_type, max_retries, initial_delay_ms, max_delay_ms, backoff_multiplier, max_concurrent, queue_size, strategy, ttl_ms, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [p.id, p.name, p.description ?? null, p.policy_type, p.max_retries ?? null, p.initial_delay_ms ?? null, p.max_delay_ms ?? null, p.backoff_multiplier ?? null, p.max_concurrent ?? null, p.queue_size ?? null, p.strategy ?? null, p.ttl_ms ?? null, p.enabled],
      );
    },

    async getReliabilityPolicy(id: string): Promise<ReliabilityPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM reliability_policies WHERE id = $1', [id]);
      return (rows[0] as ReliabilityPolicyRow | undefined) ?? null;
    },

    async listReliabilityPolicies(): Promise<ReliabilityPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM reliability_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ReliabilityPolicyRow[];
    },

    async updateReliabilityPolicy(id: string, fields: Partial<Omit<ReliabilityPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE reliability_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteReliabilityPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM reliability_policies WHERE id = $1', [id]);
    },

    // ── Collaboration Sessions ─────────────────────────────────────────────────
    async createCollaborationSession(s: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO collaboration_sessions (id, name, description, session_type, max_participants, presence_ttl_ms, auto_close_idle_ms, handoff_enabled, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [s.id, s.name, s.description ?? null, s.session_type, s.max_participants, s.presence_ttl_ms, s.auto_close_idle_ms ?? null, s.handoff_enabled, s.enabled],
      );
    },

    async getCollaborationSession(id: string): Promise<CollaborationSessionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM collaboration_sessions WHERE id = $1', [id]);
      return (rows[0] as CollaborationSessionRow | undefined) ?? null;
    },

    async listCollaborationSessions(): Promise<CollaborationSessionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM collaboration_sessions ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as CollaborationSessionRow[];
    },

    async updateCollaborationSession(id: string, fields: Partial<Omit<CollaborationSessionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE collaboration_sessions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCollaborationSession(id: string): Promise<void> {
      await ctx.query('DELETE FROM collaboration_sessions WHERE id = $1', [id]);
    },

    // ── Compliance Rules ───────────────────────────────────────────────────────
    async createComplianceRule(r: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO compliance_rules (id, name, description, rule_type, target_resource, retention_days, region, consent_purpose, action, config, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.id, r.name, r.description ?? null, r.rule_type, r.target_resource, r.retention_days ?? null, r.region ?? null, r.consent_purpose ?? null, r.action, r.config ?? null, r.enabled],
      );
    },

    async getComplianceRule(id: string): Promise<ComplianceRuleRow | null> {
      const { rows } = await ctx.query('SELECT * FROM compliance_rules WHERE id = $1', [id]);
      return (rows[0] as ComplianceRuleRow | undefined) ?? null;
    },

    async listComplianceRules(): Promise<ComplianceRuleRow[]> {
      const { rows } = await ctx.query('SELECT * FROM compliance_rules ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ComplianceRuleRow[];
    },

    async updateComplianceRule(id: string, fields: Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE compliance_rules SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteComplianceRule(id: string): Promise<void> {
      await ctx.query('DELETE FROM compliance_rules WHERE id = $1', [id]);
    },

    // ── Graph Configs ──────────────────────────────────────────────────────────
    async createGraphConfig(g: Omit<GraphConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO graph_configs (id, name, description, graph_type, max_depth, entity_types, relationship_types, auto_link, scoring_weights, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [g.id, g.name, g.description ?? null, g.graph_type, g.max_depth, g.entity_types ?? null, g.relationship_types ?? null, g.auto_link, g.scoring_weights ?? null, g.enabled],
      );
    },

    async getGraphConfig(id: string): Promise<GraphConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM graph_configs WHERE id = $1', [id]);
      return (rows[0] as GraphConfigRow | undefined) ?? null;
    },

    async listGraphConfigs(): Promise<GraphConfigRow[]> {
      const { rows } = await ctx.query('SELECT * FROM graph_configs ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as GraphConfigRow[];
    },

    async updateGraphConfig(id: string, fields: Partial<Omit<GraphConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE graph_configs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteGraphConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM graph_configs WHERE id = $1', [id]);
    },

    // ── Plugin Configs ─────────────────────────────────────────────────────────
    async createPluginConfig(p: Omit<PluginConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO plugin_configs (id, name, description, plugin_type, package_name, version, capabilities, trust_level, auto_update, config, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [p.id, p.name, p.description ?? null, p.plugin_type, p.package_name, p.version, p.capabilities ?? null, p.trust_level, p.auto_update, p.config ?? null, p.enabled],
      );
    },

    async getPluginConfig(id: string): Promise<PluginConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM plugin_configs WHERE id = $1', [id]);
      return (rows[0] as PluginConfigRow | undefined) ?? null;
    },

    async listPluginConfigs(): Promise<PluginConfigRow[]> {
      const { rows } = await ctx.query('SELECT * FROM plugin_configs ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PluginConfigRow[];
    },

    async updatePluginConfig(id: string, fields: Partial<Omit<PluginConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE plugin_configs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePluginConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM plugin_configs WHERE id = $1', [id]);
    },

    // ─── Phase 9: Scaffold Templates ───────────────────────────────────────────
    async createScaffoldTemplate(t: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO scaffold_templates (id, name, description, template_type, files, dependencies, dev_dependencies, variables, post_install, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [t.id, t.name, t.description ?? null, t.template_type, t.files ?? null, t.dependencies ?? null, t.dev_dependencies ?? null, t.variables ?? null, t.post_install ?? null, t.enabled],
      );
    },

    async getScaffoldTemplate(id: string): Promise<ScaffoldTemplateRow | null> {
      const { rows } = await ctx.query('SELECT * FROM scaffold_templates WHERE id = $1', [id]);
      return (rows[0] as ScaffoldTemplateRow | undefined) ?? null;
    },

    async listScaffoldTemplates(): Promise<ScaffoldTemplateRow[]> {
      const { rows } = await ctx.query('SELECT * FROM scaffold_templates ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ScaffoldTemplateRow[];
    },

    async updateScaffoldTemplate(id: string, fields: Partial<Omit<ScaffoldTemplateRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE scaffold_templates SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteScaffoldTemplate(id: string): Promise<void> {
      await ctx.query('DELETE FROM scaffold_templates WHERE id = $1', [id]);
    },

    // ─── Phase 9: Recipe Configs ───────────────────────────────────────────────
    async createRecipeConfig(r: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO recipe_configs (id, name, description, recipe_type, model, provider, system_prompt, tools, guardrails, max_steps, options, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, r.name, r.description ?? null, r.recipe_type, r.model ?? null, r.provider ?? null, r.system_prompt ?? null, r.tools ?? null, r.guardrails ?? null, r.max_steps ?? null, r.options ?? null, r.enabled],
      );
    },

    async getRecipeConfig(id: string): Promise<RecipeConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM recipe_configs WHERE id = $1', [id]);
      return (rows[0] as RecipeConfigRow | undefined) ?? null;
    },

    async listRecipeConfigs(): Promise<RecipeConfigRow[]> {
      const { rows } = await ctx.query('SELECT * FROM recipe_configs ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as RecipeConfigRow[];
    },

    async updateRecipeConfig(id: string, fields: Partial<Omit<RecipeConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE recipe_configs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteRecipeConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM recipe_configs WHERE id = $1', [id]);
    },

    // ─── Phase 9: Widget Configs ───────────────────────────────────────────────
    async createWidgetConfig(w: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO widget_configs (id, name, description, widget_type, default_options, allowed_contexts, max_data_points, refresh_interval_ms, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [w.id, w.name, w.description ?? null, w.widget_type, w.default_options ?? null, w.allowed_contexts ?? null, w.max_data_points ?? null, w.refresh_interval_ms ?? null, w.enabled],
      );
    },

    async getWidgetConfig(id: string): Promise<WidgetConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM widget_configs WHERE id = $1', [id]);
      return (rows[0] as WidgetConfigRow | undefined) ?? null;
    },

    async listWidgetConfigs(): Promise<WidgetConfigRow[]> {
      const { rows } = await ctx.query('SELECT * FROM widget_configs ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as WidgetConfigRow[];
    },

    async updateWidgetConfig(id: string, fields: Partial<Omit<WidgetConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE widget_configs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteWidgetConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM widget_configs WHERE id = $1', [id]);
    },

    // ─── Phase 9: Validation Rules ─────────────────────────────────────────────
    async createValidationRule(r: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO validation_rules (id, name, description, rule_type, target, condition, severity, message, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.name, r.description ?? null, r.rule_type, r.target, r.condition ?? null, r.severity, r.message ?? null, r.enabled],
      );
    },

    async getValidationRule(id: string): Promise<ValidationRuleRow | null> {
      const { rows } = await ctx.query('SELECT * FROM validation_rules WHERE id = $1', [id]);
      return (rows[0] as ValidationRuleRow | undefined) ?? null;
    },

    async listValidationRules(): Promise<ValidationRuleRow[]> {
      const { rows } = await ctx.query('SELECT * FROM validation_rules ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ValidationRuleRow[];
    },

    async updateValidationRule(id: string, fields: Partial<Omit<ValidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE validation_rules SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteValidationRule(id: string): Promise<void> {
      await ctx.query('DELETE FROM validation_rules WHERE id = $1', [id]);
    },

    // ─── Seed data ─────────────────────────────────────────────────────────────
    // SEED_DEFAULT_DATA_PLACEHOLDER
  };
}
