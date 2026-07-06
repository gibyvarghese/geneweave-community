// SPDX-License-Identifier: MIT
/**
 * Postgres store for the `IWorkflowStore` domain of the geneWeave `DatabaseAdapter`:
 * workflow definitions, handler-kind catalog, unified triggers + invocations, and the
 * mesh-contract ledger. Each method mirrors the SQLite implementation in db-sqlite.ts
 * SQL-for-SQL, with the standard SQLite→Postgres translations applied:
 *
 *   - `?` positional placeholders → `$1, $2, …`
 *   - `datetime('now')` → the ctx.now expression (UTC `YYYY-MM-DD HH:MM:SS` text)
 *   - text `ORDER BY <col>` → `COLLATE "C"` (byte order, matching SQLite's default)
 *   - `INSERT … ON CONFLICT(kind) DO UPDATE` upsert preserved verbatim (portable syntax)
 *
 * Booleans are INTEGER 0/1, JSON columns are TEXT pass-through, and every value is a bound
 * parameter. Return shapes are identical to the SQLite adapter's.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  WorkflowDefRow,
  WorkflowHandlerKindRow,
  TriggerRow,
  TriggerInvocationRow,
  MeshContractRow,
} from '../db-types/workflows.js';

export function pgWorkflowStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Workflow definitions ────────────────────────────────────────────────

    async createWorkflowDef(w: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO workflow_defs (id, name, description, version, steps, entry_step_id, metadata, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [w.id, w.name, w.description ?? null, w.version, w.steps, w.entry_step_id, w.metadata ?? null, w.enabled],
      );
    },

    async getWorkflowDef(id: string): Promise<WorkflowDefRow | null> {
      const { rows } = await ctx.query('SELECT * FROM workflow_defs WHERE id = $1', [id]);
      return (rows[0] as WorkflowDefRow | undefined) ?? null;
    },

    async listWorkflowDefs(): Promise<WorkflowDefRow[]> {
      const { rows } = await ctx.query('SELECT * FROM workflow_defs ORDER BY name COLLATE "C" ASC');
      return rows as unknown as WorkflowDefRow[];
    },

    async updateWorkflowDef(
      id: string,
      fields: Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>,
    ): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE workflow_defs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteWorkflowDef(id: string): Promise<void> {
      await ctx.query('DELETE FROM workflow_defs WHERE id = $1', [id]);
    },

    // ─── Workflow Platform Phase 1: Handler Kinds Catalog ────────────────────

    async listWorkflowHandlerKinds(): Promise<WorkflowHandlerKindRow[]> {
      const { rows } = await ctx.query('SELECT * FROM workflow_handler_kinds ORDER BY kind COLLATE "C" ASC');
      return rows as unknown as WorkflowHandlerKindRow[];
    },

    async getWorkflowHandlerKind(kind: string): Promise<WorkflowHandlerKindRow | null> {
      const { rows } = await ctx.query('SELECT * FROM workflow_handler_kinds WHERE kind = $1', [kind]);
      return (rows[0] as WorkflowHandlerKindRow | undefined) ?? null;
    },

    async upsertWorkflowHandlerKind(row: Omit<WorkflowHandlerKindRow, 'created_at' | 'updated_at'>): Promise<void> {
      // INSERT … ON CONFLICT(kind) DO UPDATE — preserves operator-edited
      // `enabled` flag and overwrites description/config_schema/source from
      // the in-process registry on every startup.
      await ctx.query(
        `INSERT INTO workflow_handler_kinds (id, kind, description, config_schema, enabled, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(kind) DO UPDATE SET
           description = excluded.description,
           config_schema = excluded.config_schema,
           source = excluded.source,
           updated_at = ${ctx.now}`,
        [row.id, row.kind, row.description ?? null, row.config_schema ?? null, row.enabled, row.source],
      );
    },

    // ─── Phase 3: Unified Triggers ───────────────────────────────────────────

    async listTriggers(opts?: { enabled?: boolean; sourceKind?: string; targetKind?: string }): Promise<TriggerRow[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.enabled !== undefined) { where.push(`enabled = $${args.length + 1}`); args.push(opts.enabled ? 1 : 0); }
      if (opts?.sourceKind) { where.push(`source_kind = $${args.length + 1}`); args.push(opts.sourceKind); }
      if (opts?.targetKind) { where.push(`target_kind = $${args.length + 1}`); args.push(opts.targetKind); }
      const sql = `SELECT * FROM triggers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY key COLLATE "C" ASC`;
      const { rows } = await ctx.query(sql, args);
      return rows as unknown as TriggerRow[];
    },

    async getTrigger(id: string): Promise<TriggerRow | null> {
      const { rows } = await ctx.query('SELECT * FROM triggers WHERE id = $1', [id]);
      return (rows[0] as TriggerRow | undefined) ?? null;
    },

    async getTriggerByKey(key: string): Promise<TriggerRow | null> {
      const { rows } = await ctx.query('SELECT * FROM triggers WHERE key = $1', [key]);
      return (rows[0] as TriggerRow | undefined) ?? null;
    },

    async createTrigger(row: Omit<TriggerRow, 'created_at' | 'updated_at'>): Promise<TriggerRow> {
      await ctx.query(
        `INSERT INTO triggers (id, key, enabled, source_kind, source_config, filter_expr, target_kind, target_config, input_map, rate_limit_per_minute, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.id, row.key, row.enabled, row.source_kind, row.source_config,
          row.filter_expr ?? null, row.target_kind, row.target_config,
          row.input_map ?? null, row.rate_limit_per_minute ?? null, row.metadata ?? null,
        ],
      );
      const { rows } = await ctx.query('SELECT * FROM triggers WHERE id = $1', [row.id]);
      const created = (rows[0] as TriggerRow | undefined) ?? null;
      if (!created) throw new Error(`createTrigger: row ${row.id} not found after insert`);
      return created;
    },

    async updateTrigger(id: string, patch: Partial<Omit<TriggerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        sets.push(`${k} = $${args.length + 1}`);
        args.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      args.push(id);
      await ctx.query(`UPDATE triggers SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
    },

    async deleteTrigger(id: string): Promise<void> {
      await ctx.query('DELETE FROM triggers WHERE id = $1', [id]);
    },

    async insertTriggerInvocation(row: Omit<TriggerInvocationRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO trigger_invocations (id, trigger_id, fired_at, source_kind, status, target_ref, error_message, source_event)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id, row.trigger_id, row.fired_at, row.source_kind, row.status,
          row.target_ref ?? null, row.error_message ?? null, row.source_event ?? null,
        ],
      );
    },

    async listTriggerInvocations(opts?: { triggerId?: string; status?: string; limit?: number; offset?: number }): Promise<TriggerInvocationRow[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.triggerId) { where.push(`trigger_id = $${args.length + 1}`); args.push(opts.triggerId); }
      if (opts?.status) { where.push(`status = $${args.length + 1}`); args.push(opts.status); }
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      const sql = `SELECT * FROM trigger_invocations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fired_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`;
      const { rows } = await ctx.query(sql, [...args, limit, offset]);
      return rows as unknown as TriggerInvocationRow[];
    },

    // ─── Phase 4: Mesh contracts ─────────────────────────────────────────────

    async insertMeshContract(row: Omit<MeshContractRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO mesh_contracts (
           id, kind, body_json, evidence_json, mesh_id,
           source_workflow_definition_id, source_workflow_run_id, source_agent_id,
           metadata, emitted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id, row.kind, row.body_json, row.evidence_json ?? null, row.mesh_id ?? null,
          row.source_workflow_definition_id ?? null, row.source_workflow_run_id ?? null, row.source_agent_id ?? null,
          row.metadata ?? null, row.emitted_at,
        ],
      );
    },

    async getMeshContract(id: string): Promise<MeshContractRow | null> {
      const { rows } = await ctx.query('SELECT * FROM mesh_contracts WHERE id = $1', [id]);
      return (rows[0] as MeshContractRow | undefined) ?? null;
    },

    async listMeshContracts(opts?: {
      kind?: string;
      meshId?: string;
      workflowRunId?: string;
      after?: string;
      before?: string;
      limit?: number;
      offset?: number;
    }): Promise<MeshContractRow[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.kind) { where.push(`kind = $${args.length + 1}`); args.push(opts.kind); }
      if (opts?.meshId) { where.push(`mesh_id = $${args.length + 1}`); args.push(opts.meshId); }
      if (opts?.workflowRunId) { where.push(`source_workflow_run_id = $${args.length + 1}`); args.push(opts.workflowRunId); }
      if (opts?.after) { where.push(`emitted_at >= $${args.length + 1}`); args.push(opts.after); }
      if (opts?.before) { where.push(`emitted_at <= $${args.length + 1}`); args.push(opts.before); }
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      const sql = `SELECT * FROM mesh_contracts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY emitted_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`;
      const { rows } = await ctx.query(sql, [...args, limit, offset]);
      return rows as unknown as MeshContractRow[];
    },
  };
}
