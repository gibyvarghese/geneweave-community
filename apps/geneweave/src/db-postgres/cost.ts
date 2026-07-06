// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `ICostStore` domain slice of the geneWeave `DatabaseAdapter`.
 *
 * Mirrors the SQLite implementation (see `SQLiteAdapter` in `../db-sqlite.ts`) statement-for-statement:
 * same SQL, same column order, same integer-boolean and TEXT-JSON conventions. The only translations
 * are the SQLite→Postgres dialect differences (`?`→`$n` placeholders, `datetime('now')`→`ctx.now`,
 * `INSERT ... ON CONFLICT`, and `COLLATE "C"` on TEXT orderings to preserve byte-order sort parity).
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type { CostPolicyRow } from '../db-types/cost-governor.js';
import type { ToolEmbeddingRow } from '../db-types/tools.js';

export function pgCostStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Cost Governor Phase 2: Cost Policies ───────────────────────────────

    async createCostPolicy(p: Omit<CostPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO cost_policies (id, key, tier, levers_json, description, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
        [p.id, p.key, p.tier, p.levers_json, p.description, p.enabled],
      );
    },

    async getCostPolicy(id: string): Promise<CostPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM cost_policies WHERE id = $1', [id]);
      return (rows[0] as CostPolicyRow | undefined) ?? null;
    },

    async getCostPolicyByKey(key: string): Promise<CostPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM cost_policies WHERE key = $1', [key]);
      return (rows[0] as CostPolicyRow | undefined) ?? null;
    },

    async listCostPolicies(opts?: { enabledOnly?: boolean }): Promise<CostPolicyRow[]> {
      const sql = `SELECT * FROM cost_policies ${opts?.enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY key COLLATE "C" ASC`;
      const { rows } = await ctx.query(sql, []);
      return rows as unknown as CostPolicyRow[];
    },

    async updateCostPolicy(
      id: string,
      fields: Partial<Omit<CostPolicyRow, 'id' | 'created_at' | 'updated_at'>>,
    ): Promise<void> {
      const allowed = new Set(['key', 'tier', 'levers_json', 'description', 'enabled']);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.has(k)) continue;
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE cost_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCostPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM cost_policies WHERE id = $1', [id]);
    },

    // ─── Cost Governor Phase 8: Tool Embeddings (Intent-RAG) ────────────────

    async upsertToolEmbedding(e: Omit<ToolEmbeddingRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_embeddings (id, tool_key, model_id, dimension, embedding, description_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(tool_key) DO UPDATE SET
           model_id = excluded.model_id,
           dimension = excluded.dimension,
           embedding = excluded.embedding,
           description_hash = excluded.description_hash,
           updated_at = ${ctx.now}`,
        [e.id, e.tool_key, e.model_id, e.dimension, e.embedding, e.description_hash],
      );
    },

    async getToolEmbedding(toolKey: string): Promise<ToolEmbeddingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_embeddings WHERE tool_key = $1', [toolKey]);
      return (rows[0] as ToolEmbeddingRow | undefined) ?? null;
    },

    async listToolEmbeddings(opts?: { modelId?: string }): Promise<ToolEmbeddingRow[]> {
      if (opts?.modelId) {
        const { rows } = await ctx.query(
          'SELECT * FROM tool_embeddings WHERE model_id = $1 ORDER BY tool_key COLLATE "C" ASC',
          [opts.modelId],
        );
        return rows as unknown as ToolEmbeddingRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM tool_embeddings ORDER BY tool_key COLLATE "C" ASC', []);
      return rows as unknown as ToolEmbeddingRow[];
    },

    async deleteToolEmbedding(toolKey: string): Promise<void> {
      await ctx.query('DELETE FROM tool_embeddings WHERE tool_key = $1', [toolKey]);
    },
  };
}
