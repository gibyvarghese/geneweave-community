// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IRoutingStore` domain slice of the geneWeave `DatabaseAdapter` — guardrails
 * (+ their append-only revision audit trail), routing policies, task-type definitions, model
 * capability scores, provider tool adapters, per-tenant task-type overrides, routing decision traces
 * (+ cost aggregation), the Phase-5 feedback loop (capability signals, message feedback, surface
 * items) and Phase-6 A/B routing experiments.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same return shapes. SQLite-isms are translated per the porting convention —
 * `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte order; NOT applied to
 * numeric score/cost columns), and `INSERT ... ON CONFLICT DO UPDATE` for upserts. Booleans are
 * INTEGER 0/1; JSON columns are TEXT pass-through; every value is a bound parameter.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  GuardrailRow,
  GuardrailRevisionRow,
  RoutingPolicyRow,
  TaskTypeDefinitionRow,
  ModelCapabilityScoreRow,
  TaskTypeTenantOverrideRow,
  ProviderToolAdapterRow,
  RoutingDecisionTraceRow,
  RoutingCapabilitySignalRow,
  MessageFeedbackRow,
  RoutingSurfaceItemRow,
  RoutingExperimentRow,
} from '../db-types/routing.js';

/** ISO-8601-with-millis UTC text, matching SQLite `new Date().toISOString()`. */
const NOW_ISO_MS = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function pgRoutingStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Guardrails ───────────────────────────────────────────────────────────
    async createGuardrail(g: Omit<GuardrailRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO guardrails (id, name, description, type, stage, config, priority, enabled, trigger_conditions, trigger_description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [g.id, g.name, g.description ?? null, g.type, g.stage, g.config ?? null, g.priority, g.enabled,
          g.trigger_conditions ?? null, g.trigger_description ?? null],
      );
    },

    async getGuardrail(id: string): Promise<GuardrailRow | null> {
      const { rows } = await ctx.query('SELECT * FROM guardrails WHERE id = $1', [id]);
      return (rows[0] as GuardrailRow | undefined) ?? null;
    },

    async listGuardrails(): Promise<GuardrailRow[]> {
      const { rows } = await ctx.query('SELECT * FROM guardrails ORDER BY priority DESC, name COLLATE "C" ASC', []);
      return rows as unknown as GuardrailRow[];
    },

    async updateGuardrail(id: string, fields: Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE guardrails SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteGuardrail(id: string): Promise<void> {
      await ctx.query('DELETE FROM guardrails WHERE id = $1', [id]);
    },

    // ─── Guardrail Revisions (W7 — append-only audit trail) ───────────────────
    async createGuardrailRevision(r: Omit<GuardrailRevisionRow, 'created_at'> & { created_at?: string }): Promise<void> {
      const createdAt = r.created_at ?? new Date().toISOString();
      await ctx.query(
        `INSERT INTO guardrail_revisions (id, guardrail_id, version, snapshot, before, actor, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.guardrail_id, r.version, r.snapshot, r.before ?? null, r.actor, r.reason, createdAt],
      );
    },

    async listGuardrailRevisions(guardrailId: string): Promise<GuardrailRevisionRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM guardrail_revisions WHERE guardrail_id = $1 ORDER BY version ASC',
        [guardrailId],
      );
      return rows as unknown as GuardrailRevisionRow[];
    },

    async getGuardrailRevisionAtTime(guardrailId: string, isoTimestamp: string): Promise<GuardrailRevisionRow | null> {
      const { rows } = await ctx.query(
        'SELECT * FROM guardrail_revisions WHERE guardrail_id = $1 AND created_at <= $2 ORDER BY created_at COLLATE "C" DESC LIMIT 1',
        [guardrailId, isoTimestamp],
      );
      return (rows[0] as GuardrailRevisionRow | undefined) ?? null;
    },

    // ─── Routing policies ─────────────────────────────────────────────────────
    async createRoutingPolicy(r: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO routing_policies (id, name, description, strategy, constraints, weights, fallback_model, fallback_provider, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.name, r.description ?? null, r.strategy, r.constraints ?? null, r.weights ?? null, r.fallback_model ?? null, r.fallback_provider ?? null, r.enabled],
      );
    },

    async getRoutingPolicy(id: string): Promise<RoutingPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM routing_policies WHERE id = $1', [id]);
      return (rows[0] as RoutingPolicyRow | undefined) ?? null;
    },

    async listRoutingPolicies(): Promise<RoutingPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM routing_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as RoutingPolicyRow[];
    },

    async updateRoutingPolicy(id: string, fields: Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE routing_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteRoutingPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM routing_policies WHERE id = $1', [id]);
    },

    // ─── Task types ───────────────────────────────────────────────────────────
    async listTaskTypes(): Promise<TaskTypeDefinitionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM task_type_definitions ORDER BY task_key COLLATE "C" ASC', []);
      return rows as unknown as TaskTypeDefinitionRow[];
    },

    async getTaskType(taskKey: string): Promise<TaskTypeDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM task_type_definitions WHERE task_key = $1', [taskKey]);
      return (rows[0] as TaskTypeDefinitionRow | undefined) ?? null;
    },

    async getTaskTypeById(id: string): Promise<TaskTypeDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM task_type_definitions WHERE id = $1', [id]);
      return (rows[0] as TaskTypeDefinitionRow | undefined) ?? null;
    },

    async createTaskType(row: Omit<TaskTypeDefinitionRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO task_type_definitions
          (id, task_key, display_name, category, description, output_modality,
           default_strategy, default_weights, inference_hints, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id, row.task_key, row.display_name, row.category, row.description ?? '',
          row.output_modality, row.default_strategy,
          row.default_weights ?? '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}',
          row.inference_hints ?? '{}',
          row.enabled ?? 1,
        ],
      );
    },

    async updateTaskType(id: string, fields: Partial<Omit<TaskTypeDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE task_type_definitions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteTaskType(id: string): Promise<void> {
      await ctx.query('DELETE FROM task_type_definitions WHERE id = $1', [id]);
    },

    // ─── Capability scores ────────────────────────────────────────────────────
    async listCapabilityScores(opts?: { taskKey?: string; tenantId?: string | null; modelId?: string; provider?: string }): Promise<ModelCapabilityScoreRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.taskKey) { where.push(`task_key = $${vals.length + 1}`); vals.push(opts.taskKey); }
      if (opts && 'tenantId' in opts) {
        if (opts.tenantId === null) { where.push('tenant_id IS NULL'); }
        else if (typeof opts.tenantId === 'string') { where.push(`(tenant_id = $${vals.length + 1} OR tenant_id IS NULL)`); vals.push(opts.tenantId); }
      }
      if (opts?.modelId) { where.push(`model_id = $${vals.length + 1}`); vals.push(opts.modelId); }
      if (opts?.provider) { where.push(`provider = $${vals.length + 1}`); vals.push(opts.provider); }
      const sql = `SELECT * FROM model_capability_scores${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY task_key COLLATE "C", provider COLLATE "C", model_id COLLATE "C"`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as ModelCapabilityScoreRow[];
    },

    async getCapabilityScore(id: string): Promise<ModelCapabilityScoreRow | null> {
      const { rows } = await ctx.query('SELECT * FROM model_capability_scores WHERE id = $1', [id]);
      return (rows[0] as ModelCapabilityScoreRow | undefined) ?? null;
    },

    async upsertCapabilityScore(row: Omit<ModelCapabilityScoreRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO model_capability_scores
          (id, tenant_id, model_id, provider, task_key, quality_score,
           supports_tools, supports_streaming, supports_thinking, supports_json_mode, supports_vision,
           max_output_tokens, benchmark_source, raw_benchmark_score, is_active, last_evaluated_at,
           production_signal_score, signal_sample_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT(tenant_id, model_id, provider, task_key) DO UPDATE SET
           quality_score = excluded.quality_score,
           supports_tools = excluded.supports_tools,
           supports_streaming = excluded.supports_streaming,
           supports_thinking = excluded.supports_thinking,
           supports_json_mode = excluded.supports_json_mode,
           supports_vision = excluded.supports_vision,
           max_output_tokens = excluded.max_output_tokens,
           benchmark_source = excluded.benchmark_source,
           raw_benchmark_score = excluded.raw_benchmark_score,
           is_active = excluded.is_active,
           last_evaluated_at = excluded.last_evaluated_at,
           updated_at = ${ctx.now}`,
        [
          row.id, row.tenant_id ?? null, row.model_id, row.provider, row.task_key, row.quality_score,
          row.supports_tools ?? 1, row.supports_streaming ?? 1, row.supports_thinking ?? 0,
          row.supports_json_mode ?? 0, row.supports_vision ?? 0,
          row.max_output_tokens ?? null, row.benchmark_source ?? null, row.raw_benchmark_score ?? null,
          row.is_active ?? 1, row.last_evaluated_at ?? null,
          row.production_signal_score ?? null, row.signal_sample_count ?? 0,
        ],
      );
    },

    async updateCapabilityScore(id: string, fields: Partial<Omit<ModelCapabilityScoreRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE model_capability_scores SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async bulkDisableCapabilityScores(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      // SQLite runs a per-id UPDATE inside a transaction with a single ISO timestamp; mirror the
      // shared-timestamp semantics with sequential awaits (one bound UPDATE per id).
      const { rows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (rows[0] as { now: string }).now;
      for (const id of ids) {
        await ctx.query('UPDATE model_capability_scores SET is_active = 0, updated_at = $1 WHERE id = $2', [now, id]);
      }
    },

    async deleteCapabilityScore(id: string): Promise<void> {
      await ctx.query('DELETE FROM model_capability_scores WHERE id = $1', [id]);
    },

    // ─── Provider tool adapters ───────────────────────────────────────────────
    async listProviderToolAdapters(): Promise<ProviderToolAdapterRow[]> {
      const { rows } = await ctx.query('SELECT * FROM provider_tool_adapters ORDER BY provider COLLATE "C" ASC', []);
      return rows as unknown as ProviderToolAdapterRow[];
    },

    async getProviderToolAdapter(provider: string): Promise<ProviderToolAdapterRow | null> {
      const { rows } = await ctx.query('SELECT * FROM provider_tool_adapters WHERE provider = $1', [provider]);
      return (rows[0] as ProviderToolAdapterRow | undefined) ?? null;
    },

    async getProviderToolAdapterById(id: string): Promise<ProviderToolAdapterRow | null> {
      const { rows } = await ctx.query('SELECT * FROM provider_tool_adapters WHERE id = $1', [id]);
      return (rows[0] as ProviderToolAdapterRow | undefined) ?? null;
    },

    async createProviderToolAdapter(row: Omit<ProviderToolAdapterRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO provider_tool_adapters
          (id, provider, display_name, adapter_module, tool_format, tool_call_response_format,
           tool_result_format, system_prompt_location, name_validation_regex, max_tool_count, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.id, row.provider, row.display_name, row.adapter_module, row.tool_format,
          row.tool_call_response_format, row.tool_result_format,
          row.system_prompt_location ?? 'system_message',
          row.name_validation_regex ?? '^[a-zA-Z0-9_-]{1,64}$',
          row.max_tool_count ?? 128,
          row.enabled ?? 1,
        ],
      );
    },

    async updateProviderToolAdapter(id: string, fields: Partial<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE provider_tool_adapters SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteProviderToolAdapter(id: string): Promise<void> {
      await ctx.query('DELETE FROM provider_tool_adapters WHERE id = $1', [id]);
    },

    // ─── Tenant overrides ─────────────────────────────────────────────────────
    async listTaskTypeTenantOverrides(opts?: { tenantId?: string; taskKey?: string }): Promise<TaskTypeTenantOverrideRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.tenantId) { where.push(`tenant_id = $${vals.length + 1}`); vals.push(opts.tenantId); }
      if (opts?.taskKey) { where.push(`task_key = $${vals.length + 1}`); vals.push(opts.taskKey); }
      const sql = `SELECT * FROM task_type_tenant_overrides${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY tenant_id COLLATE "C", task_key COLLATE "C"`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as TaskTypeTenantOverrideRow[];
    },

    async getTaskTypeTenantOverride(id: string): Promise<TaskTypeTenantOverrideRow | null> {
      const { rows } = await ctx.query('SELECT * FROM task_type_tenant_overrides WHERE id = $1', [id]);
      return (rows[0] as TaskTypeTenantOverrideRow | undefined) ?? null;
    },

    async createTaskTypeTenantOverride(row: Omit<TaskTypeTenantOverrideRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO task_type_tenant_overrides
          (id, tenant_id, task_key, weights, preferred_model_id, preferred_provider,
           preferred_boost_pct, cost_ceiling_per_call, optimisation_strategy, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id, row.tenant_id, row.task_key,
          row.weights ?? null, row.preferred_model_id ?? null, row.preferred_provider ?? null,
          row.preferred_boost_pct ?? 20,
          row.cost_ceiling_per_call ?? null, row.optimisation_strategy ?? null,
          row.enabled ?? 1,
        ],
      );
    },

    async updateTaskTypeTenantOverride(id: string, fields: Partial<Omit<TaskTypeTenantOverrideRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE task_type_tenant_overrides SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteTaskTypeTenantOverride(id: string): Promise<void> {
      await ctx.query('DELETE FROM task_type_tenant_overrides WHERE id = $1', [id]);
    },

    // ─── Routing decision traces ──────────────────────────────────────────────
    async insertRoutingDecisionTrace(row: Omit<RoutingDecisionTraceRow, 'decided_at'> & { decided_at?: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO routing_decision_traces (
           id, tenant_id, agent_id, workflow_step_id, task_key, inference_source,
           selected_model_id, selected_provider, selected_capability_score,
           weights_used, candidate_breakdown, tool_translation_applied,
           source_provider, estimated_cost_usd, decided_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, ${ctx.now}))`,
        [
          row.id,
          row.tenant_id ?? null,
          row.agent_id ?? null,
          row.workflow_step_id ?? null,
          row.task_key ?? null,
          row.inference_source ?? null,
          row.selected_model_id,
          row.selected_provider,
          row.selected_capability_score ?? null,
          row.weights_used,
          row.candidate_breakdown,
          row.tool_translation_applied ?? 0,
          row.source_provider ?? null,
          row.estimated_cost_usd ?? null,
          row.decided_at ?? null,
        ],
      );
    },

    async listRoutingDecisionTraces(opts?: { tenantId?: string; agentId?: string; taskKey?: string; limit?: number; after?: string }): Promise<RoutingDecisionTraceRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.tenantId) { where.push(`tenant_id = $${vals.length + 1}`); vals.push(opts.tenantId); }
      if (opts?.agentId) { where.push(`agent_id = $${vals.length + 1}`); vals.push(opts.agentId); }
      if (opts?.taskKey) { where.push(`task_key = $${vals.length + 1}`); vals.push(opts.taskKey); }
      if (opts?.after) { where.push(`decided_at > $${vals.length + 1}`); vals.push(opts.after); }
      const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
      const sql = `SELECT * FROM routing_decision_traces${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY decided_at COLLATE "C" DESC LIMIT ${limit}`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as RoutingDecisionTraceRow[];
    },

    async getRoutingDecisionTrace(id: string): Promise<RoutingDecisionTraceRow | null> {
      const { rows } = await ctx.query('SELECT * FROM routing_decision_traces WHERE id = $1', [id]);
      return (rows[0] as RoutingDecisionTraceRow | undefined) ?? null;
    },

    async aggregateCostByTask(opts?: { since?: string; until?: string; tenantId?: string }): Promise<Array<{
      task_key: string | null;
      selected_provider: string | null;
      selected_model_id: string | null;
      invocation_count: number;
      total_cost_usd: number;
      avg_cost_usd: number;
      last_used: string | null;
    }>> {
      const where: string[] = ['estimated_cost_usd IS NOT NULL'];
      const vals: unknown[] = [];
      if (opts?.since) { where.push(`decided_at >= $${vals.length + 1}`); vals.push(opts.since); }
      if (opts?.until) { where.push(`decided_at <= $${vals.length + 1}`); vals.push(opts.until); }
      if (opts?.tenantId) { where.push(`tenant_id = $${vals.length + 1}`); vals.push(opts.tenantId); }
      const sql = `
        SELECT
          task_key,
          selected_provider,
          selected_model_id,
          COUNT(*)::int          AS invocation_count,
          SUM(estimated_cost_usd)::float8 AS total_cost_usd,
          AVG(estimated_cost_usd)::float8 AS avg_cost_usd,
          MAX(decided_at)         AS last_used
        FROM routing_decision_traces
        WHERE ${where.join(' AND ')}
        GROUP BY task_key, selected_provider, selected_model_id
        ORDER BY total_cost_usd DESC
        LIMIT 1000`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as Array<{
        task_key: string | null;
        selected_provider: string | null;
        selected_model_id: string | null;
        invocation_count: number;
        total_cost_usd: number;
        avg_cost_usd: number;
        last_used: string | null;
      }>;
    },

    // ─── Phase 5: Feedback loop CRUD ──────────────────────────────────────────
    async insertRoutingCapabilitySignal(row: Omit<RoutingCapabilitySignalRow, 'created_at'> & { created_at?: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO routing_capability_signals (
           id, tenant_id, model_id, provider, task_key, source, signal_type,
           value, weight, evidence_id, message_id, trace_id, metadata, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, ${ctx.now}))`,
        [
          row.id, row.tenant_id ?? null, row.model_id, row.provider, row.task_key,
          row.source, row.signal_type, row.value, row.weight ?? 1.0,
          row.evidence_id ?? null, row.message_id ?? null, row.trace_id ?? null,
          row.metadata ?? null, row.created_at ?? null,
        ],
      );
    },

    async listRoutingCapabilitySignals(opts?: {
      tenantId?: string | null; modelId?: string; provider?: string; taskKey?: string;
      source?: string; afterIso?: string; beforeIso?: string; limit?: number;
    }): Promise<RoutingCapabilitySignalRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.tenantId !== undefined) {
        if (opts.tenantId === null) where.push('tenant_id IS NULL');
        else { where.push(`tenant_id = $${vals.length + 1}`); vals.push(opts.tenantId); }
      }
      if (opts?.modelId)   { where.push(`model_id = $${vals.length + 1}`);  vals.push(opts.modelId); }
      if (opts?.provider)  { where.push(`provider = $${vals.length + 1}`);  vals.push(opts.provider); }
      if (opts?.taskKey)   { where.push(`task_key = $${vals.length + 1}`);  vals.push(opts.taskKey); }
      if (opts?.source)    { where.push(`source = $${vals.length + 1}`);    vals.push(opts.source); }
      if (opts?.afterIso)  { where.push(`created_at >= $${vals.length + 1}`); vals.push(opts.afterIso); }
      if (opts?.beforeIso) { where.push(`created_at < $${vals.length + 1}`);  vals.push(opts.beforeIso); }
      const limit = Math.max(1, Math.min(opts?.limit ?? 200, 5000));
      const sql = `SELECT * FROM routing_capability_signals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT ${limit}`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as RoutingCapabilitySignalRow[];
    },

    async getRoutingCapabilitySignal(id: string): Promise<RoutingCapabilitySignalRow | null> {
      const { rows } = await ctx.query('SELECT * FROM routing_capability_signals WHERE id = $1', [id]);
      return (rows[0] as RoutingCapabilitySignalRow | undefined) ?? null;
    },

    async insertMessageFeedback(row: Omit<MessageFeedbackRow, 'created_at'> & { created_at?: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO message_feedback (
           id, message_id, chat_id, user_id, signal, comment, categories, tenant_id,
           model_id, provider, task_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, ${ctx.now}))`,
        [
          row.id, row.message_id, row.chat_id ?? null, row.user_id ?? null,
          row.signal, row.comment ?? null, row.categories ?? null, row.tenant_id ?? null,
          row.model_id ?? null, row.provider ?? null, row.task_key ?? null,
          row.created_at ?? null,
        ],
      );
    },

    async listMessageFeedback(opts?: { messageId?: string; chatId?: string; signal?: string; tenantId?: string; userId?: string; limit?: number }): Promise<MessageFeedbackRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.messageId) { where.push(`message_id = $${vals.length + 1}`); vals.push(opts.messageId); }
      if (opts?.chatId)    { where.push(`chat_id = $${vals.length + 1}`);    vals.push(opts.chatId); }
      if (opts?.signal)    { where.push(`signal = $${vals.length + 1}`);     vals.push(opts.signal); }
      if (opts?.tenantId)  { where.push(`tenant_id = $${vals.length + 1}`);  vals.push(opts.tenantId); }
      if (opts?.userId)    { where.push(`user_id = $${vals.length + 1}`);    vals.push(opts.userId); }
      const limit = Math.max(1, Math.min(opts?.limit ?? 200, 5000));
      const sql = `SELECT * FROM message_feedback${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT ${limit}`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as MessageFeedbackRow[];
    },

    async getMessageFeedback(id: string): Promise<MessageFeedbackRow | null> {
      const { rows } = await ctx.query('SELECT * FROM message_feedback WHERE id = $1', [id]);
      return (rows[0] as MessageFeedbackRow | undefined) ?? null;
    },

    async insertRoutingSurfaceItem(row: Omit<RoutingSurfaceItemRow, 'created_at' | 'resolved_at'> & { created_at?: string; resolved_at?: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO routing_surface_items (
           id, kind, severity, model_id, provider, task_key, tenant_id, message,
           metric_7d, metric_30d, drop_pct, sample_count_7d, sample_count_30d,
           auto_disabled, status, resolution_note, created_at, resolved_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, COALESCE($17, ${ctx.now}), $18)`,
        [
          row.id, row.kind, row.severity, row.model_id, row.provider, row.task_key,
          row.tenant_id ?? null, row.message,
          row.metric_7d ?? null, row.metric_30d ?? null, row.drop_pct ?? null,
          row.sample_count_7d ?? null, row.sample_count_30d ?? null,
          row.auto_disabled ?? 0, row.status ?? 'open', row.resolution_note ?? null,
          row.created_at ?? null, row.resolved_at ?? null,
        ],
      );
    },

    async listRoutingSurfaceItems(opts?: { status?: string; modelId?: string; provider?: string; taskKey?: string; limit?: number }): Promise<RoutingSurfaceItemRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.status)   { where.push(`status = $${vals.length + 1}`);   vals.push(opts.status); }
      if (opts?.modelId)  { where.push(`model_id = $${vals.length + 1}`); vals.push(opts.modelId); }
      if (opts?.provider) { where.push(`provider = $${vals.length + 1}`); vals.push(opts.provider); }
      if (opts?.taskKey)  { where.push(`task_key = $${vals.length + 1}`); vals.push(opts.taskKey); }
      const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
      const sql = `SELECT * FROM routing_surface_items${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT ${limit}`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as RoutingSurfaceItemRow[];
    },

    async getRoutingSurfaceItem(id: string): Promise<RoutingSurfaceItemRow | null> {
      const { rows } = await ctx.query('SELECT * FROM routing_surface_items WHERE id = $1', [id]);
      return (rows[0] as RoutingSurfaceItemRow | undefined) ?? null;
    },

    async updateRoutingSurfaceItem(id: string, fields: Partial<Omit<RoutingSurfaceItemRow, 'id' | 'created_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      vals.push(id);
      await ctx.query(`UPDATE routing_surface_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    // ─── Phase 6: A/B Routing Experiments ─────────────────────────────────────
    async createRoutingExperiment(r: Omit<RoutingExperimentRow, 'created_at' | 'updated_at' | 'started_at' | 'ended_at'> & { started_at?: string; ended_at?: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO routing_experiments (
           id, name, description, tenant_id, task_key,
           baseline_provider, baseline_model_id,
           candidate_provider, candidate_model_id,
           traffic_pct, status, metadata, started_at, ended_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, ${ctx.now}), $14)`,
        [
          r.id, r.name, r.description ?? null, r.tenant_id ?? null, r.task_key ?? null,
          r.baseline_provider, r.baseline_model_id,
          r.candidate_provider, r.candidate_model_id,
          r.traffic_pct, r.status ?? 'active', r.metadata ?? null,
          r.started_at ?? null, r.ended_at ?? null,
        ],
      );
    },

    async getRoutingExperiment(id: string): Promise<RoutingExperimentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM routing_experiments WHERE id = $1', [id]);
      return (rows[0] as RoutingExperimentRow | undefined) ?? null;
    },

    async listRoutingExperiments(opts?: { status?: string; taskKey?: string; tenantId?: string | null }): Promise<RoutingExperimentRow[]> {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (opts?.status) { where.push(`status = $${vals.length + 1}`); vals.push(opts.status); }
      if (opts?.taskKey) { where.push(`(task_key = $${vals.length + 1} OR task_key IS NULL)`); vals.push(opts.taskKey); }
      if (opts && 'tenantId' in opts) {
        if (opts.tenantId === null) where.push('tenant_id IS NULL');
        else if (typeof opts.tenantId === 'string') { where.push(`(tenant_id = $${vals.length + 1} OR tenant_id IS NULL)`); vals.push(opts.tenantId); }
      }
      const sql = `SELECT * FROM routing_experiments${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as RoutingExperimentRow[];
    },

    async updateRoutingExperiment(id: string, fields: Partial<Omit<RoutingExperimentRow, 'id' | 'created_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE routing_experiments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteRoutingExperiment(id: string): Promise<void> {
      await ctx.query('DELETE FROM routing_experiments WHERE id = $1', [id]);
    },
  };
}
