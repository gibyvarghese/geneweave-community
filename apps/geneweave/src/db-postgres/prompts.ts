// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IPromptStore` domain slice of the geneWeave `DatabaseAdapter` — model pricing
 * plus the whole prompt sub-entity family (prompts, versions, experiments, eval datasets/runs,
 * optimizers, optimization runs, frameworks, fragments, contracts, strategies).
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same statement order, same return shapes. SQLite-isms are translated per the
 * porting convention — `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte
 * order), `INSERT ... ON CONFLICT`. Booleans are INTEGER 0/1; JSON columns are TEXT pass-through; every
 * value is a bound parameter.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import { promptDriftReport, resyncPromptToPackage } from '../realm-prompt-drift.js';
import type { SqlClient } from '@weaveintel/realm';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type { ModelPricingRow } from '../db-types/routing.js';
import type {
  PromptRow,
  PromptFrameworkRow,
  PromptFragmentRow,
  PromptContractRow,
  PromptStrategyRow,
  PromptVersionRow,
  PromptExperimentRow,
  PromptEvalDatasetRow,
  PromptEvalRunRow,
  PromptOptimizerRow,
  PromptOptimizationRunRow,
} from '../db-types/prompts.js';

/**
 * Mirror of `SQLiteAdapter#promptCacheCols` (a private helper): derive the provider-aware prompt-cache
 * policy columns for an inbound `model_pricing` row.
 */
function promptCacheCols(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): [number, number, string] {
  const supportsPromptCache = p.provider === 'anthropic' || p.provider === 'openai' || p.provider === 'google';
  const enabled = p.prompt_cache_enabled != null ? p.prompt_cache_enabled : supportsPromptCache ? 1 : 0;
  const minTokens = p.prompt_cache_min_tokens ?? 1024;
  const ttl = p.prompt_cache_ttl === '1h' ? '1h' : '5m';
  return [enabled, minTokens, ttl];
}

export function pgPromptStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Model Pricing ─────────────────────────────────────────
    async createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
      const [pcEnabled, pcMin, pcTtl] = promptCacheCols(p);
      await ctx.query(
        `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled, prompt_cache_enabled, prompt_cache_min_tokens, prompt_cache_ttl) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled, pcEnabled, pcMin, pcTtl],
      );
    },

    async getModelPricing(id: string): Promise<ModelPricingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM model_pricing WHERE id = $1', [id]);
      return (rows[0] as ModelPricingRow | undefined) ?? null;
    },

    async listModelPricing(): Promise<ModelPricingRow[]> {
      const { rows } = await ctx.query('SELECT * FROM model_pricing ORDER BY provider COLLATE "C" ASC, model_id COLLATE "C" ASC', []);
      return rows as unknown as ModelPricingRow[];
    },

    async updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE model_pricing SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteModelPricing(id: string): Promise<void> {
      await ctx.query('DELETE FROM model_pricing WHERE id = $1', [id]);
    },

    async upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
      // On INSERT (new model from a sync), seed the provider-aware prompt-cache
      // policy. On CONFLICT (existing model) we deliberately DO NOT overwrite the
      // prompt_cache_* columns so an operator's tuning survives a pricing re-sync.
      const [pcEnabled, pcMin, pcTtl] = promptCacheCols(p);
      await ctx.query(
        `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled, prompt_cache_enabled, prompt_cache_min_tokens, prompt_cache_ttl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(model_id, provider) DO UPDATE SET
           display_name = excluded.display_name,
           input_cost_per_1m = excluded.input_cost_per_1m,
           output_cost_per_1m = excluded.output_cost_per_1m,
           quality_score = excluded.quality_score,
           source = excluded.source,
           last_synced_at = excluded.last_synced_at,
           updated_at = ${ctx.now}`,
        [p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled, pcEnabled, pcMin, pcTtl],
      );
    },

    // ─── Prompts ───────────────────────────────────────────────
    async createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompts (id, key, name, description, category, prompt_type, owner, status, tags, template, variables, version, model_compatibility, execution_defaults, framework, metadata, is_default, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          p.id,
          p.key ?? null,
          p.name,
          p.description ?? null,
          p.category ?? null,
          p.prompt_type,
          p.owner ?? null,
          p.status,
          p.tags ?? null,
          p.template,
          p.variables ?? null,
          p.version,
          p.model_compatibility ?? null,
          p.execution_defaults ?? null,
          p.framework ?? null,
          p.metadata ?? null,
          p.is_default,
          p.enabled,
        ],
      );
    },

    async insertRealmPromptRow(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompts (id, key, name, description, category, prompt_type, owner, status, tags, template, variables, version, model_compatibility, execution_defaults, framework, metadata, is_default, enabled, realm, owner_tenant_id, logical_key, origin_id, origin_hash, content_hash, track_mode, share_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
        [
          p.id, p.key ?? null, p.name, p.description ?? null, p.category ?? null, p.prompt_type,
          p.owner ?? null, p.status, p.tags ?? null, p.template, p.variables ?? null, p.version,
          p.model_compatibility ?? null, p.execution_defaults ?? null, p.framework ?? null, p.metadata ?? null,
          p.is_default, p.enabled,
          p.realm ?? 'tenant', p.owner_tenant_id ?? null, p.logical_key ?? null, p.origin_id ?? null,
          p.origin_hash ?? null, p.content_hash ?? '', p.track_mode ?? 'pin', p.share_mode ?? 'private',
        ],
      );
    },

    async promptDriftReport() {
      return promptDriftReport(ctx as unknown as SqlClient, 'postgres');
    },

    async resyncPromptToPackage(promptId: string) {
      return resyncPromptToPackage(ctx as unknown as SqlClient, 'postgres', promptId);
    },

    async getPrompt(id: string): Promise<PromptRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompts WHERE id = $1', [id]);
      return (rows[0] as PromptRow | undefined) ?? null;
    },

    async getPromptByKey(key: string): Promise<PromptRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompts WHERE key = $1', [key]);
      return (rows[0] as PromptRow | undefined) ?? null;
    },

    async getPromptByName(name: string): Promise<PromptRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompts WHERE name = $1', [name]);
      return (rows[0] as PromptRow | undefined) ?? null;
    },

    async listPrompts(): Promise<PromptRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompts ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptRow[];
    },

    async updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePrompt(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompts WHERE id = $1', [id]);
    },

    // ─── Prompt Versions ───────────────────────────────────────
    async createPromptVersion(v: Omit<PromptVersionRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_versions (id, prompt_id, version, status, template, variables, model_compatibility, execution_defaults, framework, metadata, is_active, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          v.id,
          v.prompt_id,
          v.version,
          v.status,
          v.template,
          v.variables ?? null,
          v.model_compatibility ?? null,
          v.execution_defaults ?? null,
          v.framework ?? null,
          v.metadata ?? null,
          v.is_active,
          v.enabled,
        ],
      );
      if (v.is_active) {
        await ctx.query(`UPDATE prompt_versions SET is_active = 0, updated_at = ${ctx.now} WHERE prompt_id = $1 AND id <> $2`, [v.prompt_id, v.id]);
      }
    },

    async getPromptVersion(id: string): Promise<PromptVersionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_versions WHERE id = $1', [id]);
      return (rows[0] as PromptVersionRow | undefined) ?? null;
    },

    async listPromptVersions(promptId?: string): Promise<PromptVersionRow[]> {
      if (promptId) {
        const { rows } = await ctx.query('SELECT * FROM prompt_versions WHERE prompt_id = $1 ORDER BY created_at COLLATE "C" DESC', [promptId]);
        return rows as unknown as PromptVersionRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM prompt_versions ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as PromptVersionRow[];
    },

    async updatePromptVersion(id: string, fields: Partial<Omit<PromptVersionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const existing = await this.getPromptVersion!(id);
      if (!existing) return;

      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_versions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

      if (fields['is_active']) {
        await ctx.query(`UPDATE prompt_versions SET is_active = 0, updated_at = ${ctx.now} WHERE prompt_id = $1 AND id <> $2`, [existing.prompt_id, id]);
      }
    },

    async deletePromptVersion(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_versions WHERE id = $1', [id]);
    },

    // ─── Prompt Experiments ────────────────────────────────────
    async createPromptExperiment(e: Omit<PromptExperimentRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_experiments (id, prompt_id, name, description, status, variants_json, assignment_key_template, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.id,
          e.prompt_id,
          e.name,
          e.description ?? null,
          e.status,
          e.variants_json,
          e.assignment_key_template ?? null,
          e.enabled,
        ],
      );
    },

    async getPromptExperiment(id: string): Promise<PromptExperimentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_experiments WHERE id = $1', [id]);
      return (rows[0] as PromptExperimentRow | undefined) ?? null;
    },

    async listPromptExperiments(promptId?: string): Promise<PromptExperimentRow[]> {
      if (promptId) {
        const { rows } = await ctx.query('SELECT * FROM prompt_experiments WHERE prompt_id = $1 ORDER BY created_at COLLATE "C" DESC', [promptId]);
        return rows as unknown as PromptExperimentRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM prompt_experiments ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as PromptExperimentRow[];
    },

    async updatePromptExperiment(id: string, fields: Partial<Omit<PromptExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_experiments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptExperiment(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_experiments WHERE id = $1', [id]);
    },

    // ─── Prompt Evaluation Datasets ────────────────────────────
    async createPromptEvalDataset(d: Omit<PromptEvalDatasetRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_eval_datasets (id, prompt_id, name, description, prompt_version, status, pass_threshold, cases_json, rubric_json, metadata, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          d.id,
          d.prompt_id,
          d.name,
          d.description ?? null,
          d.prompt_version ?? null,
          d.status,
          d.pass_threshold,
          d.cases_json,
          d.rubric_json ?? null,
          d.metadata ?? null,
          d.enabled,
        ],
      );
    },

    async getPromptEvalDataset(id: string): Promise<PromptEvalDatasetRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_eval_datasets WHERE id = $1', [id]);
      return (rows[0] as PromptEvalDatasetRow | undefined) ?? null;
    },

    async listPromptEvalDatasets(promptId?: string): Promise<PromptEvalDatasetRow[]> {
      if (promptId) {
        const { rows } = await ctx.query('SELECT * FROM prompt_eval_datasets WHERE prompt_id = $1 ORDER BY created_at COLLATE "C" DESC', [promptId]);
        return rows as unknown as PromptEvalDatasetRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM prompt_eval_datasets ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as PromptEvalDatasetRow[];
    },

    async updatePromptEvalDataset(id: string, fields: Partial<Omit<PromptEvalDatasetRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_eval_datasets SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptEvalDataset(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_eval_datasets WHERE id = $1', [id]);
    },

    // ─── Prompt Evaluation Runs ────────────────────────────────
    async createPromptEvalRun(r: Omit<PromptEvalRunRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_eval_runs (id, dataset_id, prompt_id, prompt_version, status, avg_score, passed_cases, failed_cases, total_cases, results_json, summary_json, metadata, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          r.id,
          r.dataset_id,
          r.prompt_id,
          r.prompt_version,
          r.status,
          r.avg_score,
          r.passed_cases,
          r.failed_cases,
          r.total_cases,
          r.results_json,
          r.summary_json ?? null,
          r.metadata ?? null,
          r.completed_at ?? null,
        ],
      );
    },

    async getPromptEvalRun(id: string): Promise<PromptEvalRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_eval_runs WHERE id = $1', [id]);
      return (rows[0] as PromptEvalRunRow | undefined) ?? null;
    },

    async listPromptEvalRuns(datasetId?: string): Promise<PromptEvalRunRow[]> {
      if (datasetId) {
        const { rows } = await ctx.query('SELECT * FROM prompt_eval_runs WHERE dataset_id = $1 ORDER BY created_at COLLATE "C" DESC', [datasetId]);
        return rows as unknown as PromptEvalRunRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM prompt_eval_runs ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as PromptEvalRunRow[];
    },

    async deletePromptEvalRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_eval_runs WHERE id = $1', [id]);
    },

    // ─── Prompt Optimizers ─────────────────────────────────────
    async createPromptOptimizer(o: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_optimizers (id, key, name, description, implementation_kind, config, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [o.id, o.key, o.name, o.description ?? null, o.implementation_kind, o.config, o.enabled],
      );
    },

    async getPromptOptimizer(id: string): Promise<PromptOptimizerRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_optimizers WHERE id = $1', [id]);
      return (rows[0] as PromptOptimizerRow | undefined) ?? null;
    },

    async getPromptOptimizerByKey(key: string): Promise<PromptOptimizerRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_optimizers WHERE key = $1', [key]);
      return (rows[0] as PromptOptimizerRow | undefined) ?? null;
    },

    async listPromptOptimizers(): Promise<PromptOptimizerRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompt_optimizers ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptOptimizerRow[];
    },

    async updatePromptOptimizer(id: string, fields: Partial<Omit<PromptOptimizerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_optimizers SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptOptimizer(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_optimizers WHERE id = $1', [id]);
    },

    // ─── Prompt Optimization Runs ──────────────────────────────
    async createPromptOptimizationRun(r: Omit<PromptOptimizationRunRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_optimization_runs (id, prompt_id, source_version, candidate_version, optimizer_id, objective, source_template, candidate_template, diff_json, eval_baseline_json, eval_candidate_json, status, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          r.id,
          r.prompt_id,
          r.source_version,
          r.candidate_version,
          r.optimizer_id ?? null,
          r.objective,
          r.source_template,
          r.candidate_template,
          r.diff_json,
          r.eval_baseline_json ?? null,
          r.eval_candidate_json ?? null,
          r.status,
          r.metadata ?? null,
        ],
      );
    },

    async getPromptOptimizationRun(id: string): Promise<PromptOptimizationRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_optimization_runs WHERE id = $1', [id]);
      return (rows[0] as PromptOptimizationRunRow | undefined) ?? null;
    },

    async listPromptOptimizationRuns(promptId?: string): Promise<PromptOptimizationRunRow[]> {
      if (promptId) {
        const { rows } = await ctx.query('SELECT * FROM prompt_optimization_runs WHERE prompt_id = $1 ORDER BY created_at COLLATE "C" DESC', [promptId]);
        return rows as unknown as PromptOptimizationRunRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM prompt_optimization_runs ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as PromptOptimizationRunRow[];
    },

    async deletePromptOptimizationRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_optimization_runs WHERE id = $1', [id]);
    },

    // ─── Prompt Frameworks ─────────────────────────────────────
    async createPromptFramework(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_frameworks (id, key, name, description, sections, section_separator, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [f.id, f.key, f.name, f.description ?? null, f.sections, f.section_separator, f.enabled],
      );
    },

    async getPromptFramework(id: string): Promise<PromptFrameworkRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_frameworks WHERE id = $1', [id]);
      return (rows[0] as PromptFrameworkRow | undefined) ?? null;
    },

    async getPromptFrameworkByKey(key: string): Promise<PromptFrameworkRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_frameworks WHERE key = $1', [key]);
      return (rows[0] as PromptFrameworkRow | undefined) ?? null;
    },

    async listPromptFrameworks(): Promise<PromptFrameworkRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompt_frameworks ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptFrameworkRow[];
    },

    async updatePromptFramework(id: string, fields: Partial<Omit<PromptFrameworkRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_frameworks SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptFramework(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_frameworks WHERE id = $1', [id]);
    },

    // ─── Prompt Fragments ──────────────────────────────────────
    async createPromptFragment(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_fragments (id, key, name, description, category, content, variables, tags, version, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [f.id, f.key, f.name, f.description ?? null, f.category ?? null, f.content, f.variables ?? null, f.tags ?? null, f.version, f.enabled],
      );
    },

    async getPromptFragment(id: string): Promise<PromptFragmentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_fragments WHERE id = $1', [id]);
      return (rows[0] as PromptFragmentRow | undefined) ?? null;
    },

    async getPromptFragmentByKey(key: string): Promise<PromptFragmentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_fragments WHERE key = $1', [key]);
      return (rows[0] as PromptFragmentRow | undefined) ?? null;
    },

    async listPromptFragments(): Promise<PromptFragmentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompt_fragments ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptFragmentRow[];
    },

    async updatePromptFragment(id: string, fields: Partial<Omit<PromptFragmentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_fragments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptFragment(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_fragments WHERE id = $1', [id]);
    },

    // ─── Prompt Contracts ──────────────────────────────────────
    async createPromptContract(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_contracts (id, key, name, description, contract_type, schema, config, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [c.id, c.key, c.name, c.description ?? null, c.contract_type, c.schema ?? null, c.config, c.enabled],
      );
    },

    async getPromptContract(id: string): Promise<PromptContractRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_contracts WHERE id = $1', [id]);
      return (rows[0] as PromptContractRow | undefined) ?? null;
    },

    async getPromptContractByKey(key: string): Promise<PromptContractRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_contracts WHERE key = $1', [key]);
      return (rows[0] as PromptContractRow | undefined) ?? null;
    },

    async listPromptContracts(): Promise<PromptContractRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompt_contracts ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptContractRow[];
    },

    async updatePromptContract(id: string, fields: Partial<Omit<PromptContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_contracts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptContract(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_contracts WHERE id = $1', [id]);
    },

    // ─── Prompt Strategies ─────────────────────────────────────
    async createPromptStrategy(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_strategies (id, key, name, description, instruction_prefix, instruction_suffix, config, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.id, s.key, s.name, s.description ?? null, s.instruction_prefix ?? null, s.instruction_suffix ?? null, s.config, s.enabled],
      );
    },

    async getPromptStrategy(id: string): Promise<PromptStrategyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_strategies WHERE id = $1', [id]);
      return (rows[0] as PromptStrategyRow | undefined) ?? null;
    },

    async getPromptStrategyByKey(key: string): Promise<PromptStrategyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM prompt_strategies WHERE key = $1', [key]);
      return (rows[0] as PromptStrategyRow | undefined) ?? null;
    },

    async listPromptStrategies(): Promise<PromptStrategyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM prompt_strategies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as PromptStrategyRow[];
    },

    async updatePromptStrategy(id: string, fields: Partial<Omit<PromptStrategyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE prompt_strategies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deletePromptStrategy(id: string): Promise<void> {
      await ctx.query('DELETE FROM prompt_strategies WHERE id = $1', [id]);
    },
  };
}
