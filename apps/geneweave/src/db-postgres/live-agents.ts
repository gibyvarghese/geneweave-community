// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `ILiveAgentsStore` domain slice of the geneWeave `DatabaseAdapter` — the
 * DB-driven live-agents mesh *blueprints* (mesh/agent definitions, delegation edges), the runtime
 * *catalog* (handler kinds, attention policies), the *provisioned* runtime (meshes, agents, handler &
 * tool bindings), and the run ledger (runs, API-initiated runs, run steps, append-only run events).
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same return shapes. `create*`/`append*` INSERT then SELECT the freshly-
 * written row back so the API can return it verbatim. SQLite-isms are translated per the porting
 * convention — `?`→`$n` (dynamic SET builders renumber), `datetime('now')`→`${ctx.now}`, text
 * `ORDER BY`→`COLLATE "C"` (byte order; NOT applied to the numeric `ordering` column). Booleans are
 * INTEGER 0/1 (read back as numbers); JSON columns are TEXT pass-through; every value is a bound
 * parameter. Multi-statement work runs as sequential awaits.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  LiveMeshDefinitionRow,
  LiveAgentDefinitionRow,
  LiveMeshDelegationEdgeRow,
  LiveHandlerKindRow,
  LiveAttentionPolicyRow,
  LiveMeshRow,
  LiveAgentRow,
  LiveAgentHandlerBindingRow,
  LiveAgentToolBindingRow,
  LiveRunRow,
  LiveRunStepRow,
  LiveRunEventRow,
  ApiLiveRunRow,
} from '../db-types/live-agents.js';

export function pgLiveAgentsStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  /** Shared dynamic-patch UPDATE (mirrors the SQLite `for..of Object.entries` builder). */
  const buildUpdate = async (table: string, id: string, patch: Record<string, unknown>): Promise<void> => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = $${vals.length + 1}`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = ${ctx.now}`);
    vals.push(id);
    await ctx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  };

  return {
    // ─── Live mesh definitions (M21) ─────────────────────────────────────────
    async listLiveMeshDefinitions(opts: { enabledOnly?: boolean } = {}): Promise<LiveMeshDefinitionRow[]> {
      const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
      const { rows } = await ctx.query(`SELECT * FROM live_mesh_definitions ${where} ORDER BY mesh_key COLLATE "C" ASC`, []);
      return rows as unknown as LiveMeshDefinitionRow[];
    },

    async getLiveMeshDefinition(id: string): Promise<LiveMeshDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_mesh_definitions WHERE id = $1', [id]);
      return (rows[0] as LiveMeshDefinitionRow | undefined) ?? null;
    },

    async getLiveMeshDefinitionByKey(meshKey: string): Promise<LiveMeshDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_mesh_definitions WHERE mesh_key = $1', [meshKey]);
      return (rows[0] as LiveMeshDefinitionRow | undefined) ?? null;
    },

    async createLiveMeshDefinition(row: Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDefinitionRow> {
      await ctx.query(
        `INSERT INTO live_mesh_definitions (id, mesh_key, name, charter_prose, dual_control_required_for, enabled, description) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.mesh_key, row.name, row.charter_prose, row.dual_control_required_for, row.enabled, row.description],
      );
      const { rows } = await ctx.query('SELECT * FROM live_mesh_definitions WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveMeshDefinitionRow;
    },

    async updateLiveMeshDefinition(id: string, patch: Partial<Omit<LiveMeshDefinitionRow, 'id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_mesh_definitions', id, patch);
    },

    async deleteLiveMeshDefinition(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_mesh_definitions WHERE id = $1', [id]);
    },

    // ─── Live agent definitions ──────────────────────────────────────────────
    async listLiveAgentDefinitions(opts: { meshDefId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentDefinitionRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.meshDefId) { where.push(`mesh_def_id = $${params.length + 1}`); params.push(opts.meshDefId); }
      if (opts.enabledOnly) where.push('enabled = 1');
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_agent_definitions ${whereSql} ORDER BY mesh_def_id COLLATE "C", ordering ASC, role_key COLLATE "C" ASC`, params);
      return rows as unknown as LiveAgentDefinitionRow[];
    },

    async getLiveAgentDefinition(id: string): Promise<LiveAgentDefinitionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_agent_definitions WHERE id = $1', [id]);
      return (rows[0] as LiveAgentDefinitionRow | undefined) ?? null;
    },

    async createLiveAgentDefinition(row: Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveAgentDefinitionRow> {
      await ctx.query(
        `INSERT INTO live_agent_definitions (id, mesh_def_id, role_key, name, role_label, persona, objectives, success_indicators, ordering, enabled, model_capability_json, model_routing_policy_key, model_pinned_id, default_handler_kind, default_handler_config_json, default_tool_catalog_keys, default_attention_policy_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          row.id, row.mesh_def_id, row.role_key, row.name, row.role_label, row.persona,
          row.objectives, row.success_indicators, row.ordering, row.enabled,
          row.model_capability_json ?? null, row.model_routing_policy_key ?? null,
          row.model_pinned_id ?? null,
          row.default_handler_kind ?? null, row.default_handler_config_json ?? null,
          row.default_tool_catalog_keys ?? null, row.default_attention_policy_key ?? null,
        ],
      );
      const { rows } = await ctx.query('SELECT * FROM live_agent_definitions WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveAgentDefinitionRow;
    },

    async updateLiveAgentDefinition(id: string, patch: Partial<Omit<LiveAgentDefinitionRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_agent_definitions', id, patch);
    },

    async deleteLiveAgentDefinition(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_agent_definitions WHERE id = $1', [id]);
    },

    // ─── Live mesh delegation edges ──────────────────────────────────────────
    async listLiveMeshDelegationEdges(opts: { meshDefId?: string; enabledOnly?: boolean } = {}): Promise<LiveMeshDelegationEdgeRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.meshDefId) { where.push(`mesh_def_id = $${params.length + 1}`); params.push(opts.meshDefId); }
      if (opts.enabledOnly) where.push('enabled = 1');
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_mesh_delegation_edges ${whereSql} ORDER BY mesh_def_id COLLATE "C", ordering ASC`, params);
      return rows as unknown as LiveMeshDelegationEdgeRow[];
    },

    async getLiveMeshDelegationEdge(id: string): Promise<LiveMeshDelegationEdgeRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_mesh_delegation_edges WHERE id = $1', [id]);
      return (rows[0] as LiveMeshDelegationEdgeRow | undefined) ?? null;
    },

    async createLiveMeshDelegationEdge(row: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDelegationEdgeRow> {
      await ctx.query(
        `INSERT INTO live_mesh_delegation_edges (id, mesh_def_id, from_role_key, to_role_key, relationship, prose, ordering, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.id, row.mesh_def_id, row.from_role_key, row.to_role_key, row.relationship, row.prose, row.ordering, row.enabled],
      );
      const { rows } = await ctx.query('SELECT * FROM live_mesh_delegation_edges WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveMeshDelegationEdgeRow;
    },

    async updateLiveMeshDelegationEdge(id: string, patch: Partial<Omit<LiveMeshDelegationEdgeRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_mesh_delegation_edges', id, patch);
    },

    async deleteLiveMeshDelegationEdge(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_mesh_delegation_edges WHERE id = $1', [id]);
    },

    // ─── live_handler_kinds ──────────────────────────────────────────────────
    async listLiveHandlerKinds(opts: { enabledOnly?: boolean } = {}): Promise<LiveHandlerKindRow[]> {
      const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
      const { rows } = await ctx.query(`SELECT * FROM live_handler_kinds ${where} ORDER BY kind COLLATE "C" ASC`, []);
      return rows as unknown as LiveHandlerKindRow[];
    },
    async getLiveHandlerKind(id: string): Promise<LiveHandlerKindRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_handler_kinds WHERE id = $1', [id]);
      return (rows[0] as LiveHandlerKindRow | undefined) ?? null;
    },
    async getLiveHandlerKindByKind(kind: string): Promise<LiveHandlerKindRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_handler_kinds WHERE kind = $1', [kind]);
      return (rows[0] as LiveHandlerKindRow | undefined) ?? null;
    },
    async createLiveHandlerKind(row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'>): Promise<LiveHandlerKindRow> {
      await ctx.query(
        `INSERT INTO live_handler_kinds (id, kind, description, config_schema_json, source, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.kind, row.description, row.config_schema_json, row.source, row.enabled],
      );
      const { rows } = await ctx.query('SELECT * FROM live_handler_kinds WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveHandlerKindRow;
    },
    async updateLiveHandlerKind(id: string, patch: Partial<Omit<LiveHandlerKindRow, 'id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_handler_kinds', id, patch);
    },
    async deleteLiveHandlerKind(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_handler_kinds WHERE id = $1', [id]);
    },

    // ─── live_attention_policies ─────────────────────────────────────────────
    async listLiveAttentionPolicies(opts: { enabledOnly?: boolean } = {}): Promise<LiveAttentionPolicyRow[]> {
      const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
      const { rows } = await ctx.query(`SELECT * FROM live_attention_policies ${where} ORDER BY key COLLATE "C" ASC`, []);
      return rows as unknown as LiveAttentionPolicyRow[];
    },
    async getLiveAttentionPolicy(id: string): Promise<LiveAttentionPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_attention_policies WHERE id = $1', [id]);
      return (rows[0] as LiveAttentionPolicyRow | undefined) ?? null;
    },
    async getLiveAttentionPolicyByKey(key: string): Promise<LiveAttentionPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_attention_policies WHERE key = $1', [key]);
      return (rows[0] as LiveAttentionPolicyRow | undefined) ?? null;
    },
    async createLiveAttentionPolicy(row: Omit<LiveAttentionPolicyRow, 'created_at' | 'updated_at'>): Promise<LiveAttentionPolicyRow> {
      await ctx.query(
        `INSERT INTO live_attention_policies (id, key, kind, description, config_json, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.key, row.kind, row.description, row.config_json, row.enabled],
      );
      const { rows } = await ctx.query('SELECT * FROM live_attention_policies WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveAttentionPolicyRow;
    },
    async updateLiveAttentionPolicy(id: string, patch: Partial<Omit<LiveAttentionPolicyRow, 'id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_attention_policies', id, patch);
    },
    async deleteLiveAttentionPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_attention_policies WHERE id = $1', [id]);
    },

    // ─── live_meshes (provisioned) ───────────────────────────────────────────
    async listLiveMeshes(opts: { tenantId?: string; meshDefId?: string; status?: string } = {}): Promise<LiveMeshRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.tenantId)  { where.push(`tenant_id = $${params.length + 1}`);   params.push(opts.tenantId); }
      if (opts.meshDefId) { where.push(`mesh_def_id = $${params.length + 1}`); params.push(opts.meshDefId); }
      if (opts.status)    { where.push(`status = $${params.length + 1}`);      params.push(opts.status); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_meshes ${whereSql} ORDER BY created_at COLLATE "C" DESC`, params);
      return rows as unknown as LiveMeshRow[];
    },
    async getLiveMesh(id: string): Promise<LiveMeshRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_meshes WHERE id = $1', [id]);
      return (rows[0] as LiveMeshRow | undefined) ?? null;
    },
    async createLiveMesh(row: Omit<LiveMeshRow, 'created_at' | 'updated_at'>): Promise<LiveMeshRow> {
      await ctx.query(
        `INSERT INTO live_meshes (id, tenant_id, mesh_def_id, name, status, domain, dual_control_required_for, owner_human_id, mcp_server_ref, account_id, context_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.id, row.tenant_id, row.mesh_def_id, row.name, row.status, row.domain, row.dual_control_required_for, row.owner_human_id, row.mcp_server_ref, row.account_id, row.context_json],
      );
      const { rows } = await ctx.query('SELECT * FROM live_meshes WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveMeshRow;
    },
    async updateLiveMesh(id: string, patch: Partial<Omit<LiveMeshRow, 'id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_meshes', id, patch);
    },
    async deleteLiveMesh(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_meshes WHERE id = $1', [id]);
    },

    // ─── live_agents (provisioned) ───────────────────────────────────────────
    async listLiveAgents(opts: { meshId?: string; status?: string } = {}): Promise<LiveAgentRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.meshId) { where.push(`mesh_id = $${params.length + 1}`); params.push(opts.meshId); }
      if (opts.status) { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_agents ${whereSql} ORDER BY mesh_id COLLATE "C", ordering ASC, role_key COLLATE "C" ASC`, params);
      return rows as unknown as LiveAgentRow[];
    },
    async getLiveAgent(id: string): Promise<LiveAgentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_agents WHERE id = $1', [id]);
      return (rows[0] as LiveAgentRow | undefined) ?? null;
    },
    async createLiveAgent(row: Omit<LiveAgentRow, 'created_at' | 'updated_at'>): Promise<LiveAgentRow> {
      await ctx.query(
        `INSERT INTO live_agents (id, mesh_id, agent_def_id, role_key, name, role_label, persona, objectives, success_indicators, attention_policy_key, contract_version_id, status, ordering, archived_at, model_capability_json, model_routing_policy_key, model_pinned_id, prepare_config_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [row.id, row.mesh_id, row.agent_def_id, row.role_key, row.name, row.role_label, row.persona, row.objectives, row.success_indicators, row.attention_policy_key, row.contract_version_id, row.status, row.ordering, row.archived_at, row.model_capability_json ?? null, row.model_routing_policy_key ?? null, row.model_pinned_id ?? null, row.prepare_config_json ?? null],
      );
      const { rows } = await ctx.query('SELECT * FROM live_agents WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveAgentRow;
    },
    async updateLiveAgent(id: string, patch: Partial<Omit<LiveAgentRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_agents', id, patch);
    },
    async deleteLiveAgent(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_agents WHERE id = $1', [id]);
    },

    // ─── live_agent_handler_bindings ─────────────────────────────────────────
    async listLiveAgentHandlerBindings(opts: { agentId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentHandlerBindingRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.agentId)     { where.push(`agent_id = $${params.length + 1}`); params.push(opts.agentId); }
      if (opts.enabledOnly) { where.push('enabled = 1'); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_agent_handler_bindings ${whereSql} ORDER BY agent_id COLLATE "C", handler_kind COLLATE "C"`, params);
      return rows as unknown as LiveAgentHandlerBindingRow[];
    },
    async getLiveAgentHandlerBinding(id: string): Promise<LiveAgentHandlerBindingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_agent_handler_bindings WHERE id = $1', [id]);
      return (rows[0] as LiveAgentHandlerBindingRow | undefined) ?? null;
    },
    async createLiveAgentHandlerBinding(row: Omit<LiveAgentHandlerBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentHandlerBindingRow> {
      await ctx.query(
        `INSERT INTO live_agent_handler_bindings (id, agent_id, handler_kind, config_json, enabled) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.agent_id, row.handler_kind, row.config_json, row.enabled],
      );
      const { rows } = await ctx.query('SELECT * FROM live_agent_handler_bindings WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveAgentHandlerBindingRow;
    },
    async updateLiveAgentHandlerBinding(id: string, patch: Partial<Omit<LiveAgentHandlerBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_agent_handler_bindings', id, patch);
    },
    async deleteLiveAgentHandlerBinding(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_agent_handler_bindings WHERE id = $1', [id]);
    },

    // ─── live_agent_tool_bindings ────────────────────────────────────────────
    async listLiveAgentToolBindings(opts: { agentId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentToolBindingRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.agentId)     { where.push(`agent_id = $${params.length + 1}`); params.push(opts.agentId); }
      if (opts.enabledOnly) { where.push('enabled = 1'); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_agent_tool_bindings ${whereSql} ORDER BY agent_id COLLATE "C"`, params);
      return rows as unknown as LiveAgentToolBindingRow[];
    },
    async getLiveAgentToolBinding(id: string): Promise<LiveAgentToolBindingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_agent_tool_bindings WHERE id = $1', [id]);
      return (rows[0] as LiveAgentToolBindingRow | undefined) ?? null;
    },
    async createLiveAgentToolBinding(row: Omit<LiveAgentToolBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentToolBindingRow> {
      await ctx.query(
        `INSERT INTO live_agent_tool_bindings (id, agent_id, tool_catalog_id, mcp_server_url, capability_keys, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.agent_id, row.tool_catalog_id, row.mcp_server_url, row.capability_keys, row.enabled],
      );
      const { rows } = await ctx.query('SELECT * FROM live_agent_tool_bindings WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveAgentToolBindingRow;
    },
    async updateLiveAgentToolBinding(id: string, patch: Partial<Omit<LiveAgentToolBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_agent_tool_bindings', id, patch);
    },
    async deleteLiveAgentToolBinding(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_agent_tool_bindings WHERE id = $1', [id]);
    },

    // ─── live_runs ───────────────────────────────────────────────────────────
    async listLiveRuns(opts: { meshId?: string; tenantId?: string; status?: string; limit?: number } = {}): Promise<LiveRunRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.meshId)   { where.push(`mesh_id = $${params.length + 1}`);   params.push(opts.meshId); }
      if (opts.tenantId) { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      if (opts.status)   { where.push(`status = $${params.length + 1}`);    params.push(opts.status); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limitSql  = opts.limit ? `LIMIT ${Number(opts.limit)}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_runs ${whereSql} ORDER BY started_at COLLATE "C" DESC ${limitSql}`, params);
      return rows as unknown as LiveRunRow[];
    },
    async getLiveRun(id: string): Promise<LiveRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_runs WHERE id = $1', [id]);
      return (rows[0] as LiveRunRow | undefined) ?? null;
    },
    async createLiveRun(row: Omit<LiveRunRow, 'created_at' | 'updated_at'>): Promise<LiveRunRow> {
      await ctx.query(
        `INSERT INTO live_runs (id, mesh_id, tenant_id, run_key, label, status, started_at, completed_at, summary, context_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [row.id, row.mesh_id, row.tenant_id, row.run_key, row.label, row.status, row.started_at, row.completed_at, row.summary, row.context_json],
      );
      const { rows } = await ctx.query('SELECT * FROM live_runs WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveRunRow;
    },
    async updateLiveRun(id: string, patch: Partial<Omit<LiveRunRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_runs', id, patch);
    },
    async deleteLiveRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_runs WHERE id = $1', [id]);
    },

    // ─── api_live_runs (user-scoped, no mesh FK, durable stop signal) ────────
    async createApiLiveRun(row: Omit<ApiLiveRunRow, 'created_at' | 'updated_at'>): Promise<ApiLiveRunRow> {
      await ctx.query(
        `INSERT INTO api_live_runs (id, user_id, tenant_id, agent_id, status, stop_requested, config_json) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.user_id, row.tenant_id ?? null, row.agent_id ?? null, row.status, row.stop_requested ?? 0, row.config_json ?? null],
      );
      const { rows } = await ctx.query('SELECT * FROM api_live_runs WHERE id = $1', [row.id]);
      return rows[0] as unknown as ApiLiveRunRow;
    },
    async getApiLiveRun(id: string): Promise<ApiLiveRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM api_live_runs WHERE id = $1', [id]);
      return (rows[0] as ApiLiveRunRow | undefined) ?? null;
    },
    async listUserApiLiveRuns(userId: string, opts: { status?: string; limit?: number } = {}): Promise<ApiLiveRunRow[]> {
      const where: string[] = ['user_id = $1'];
      const params: unknown[] = [userId];
      if (opts.status) { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
      const limitSql = opts.limit ? `LIMIT ${Number(opts.limit)}` : 'LIMIT 100';
      const { rows } = await ctx.query(`SELECT * FROM api_live_runs WHERE ${where.join(' AND ')} ORDER BY created_at COLLATE "C" DESC ${limitSql}`, params);
      return rows as unknown as ApiLiveRunRow[];
    },
    async updateApiLiveRun(id: string, patch: Partial<Omit<ApiLiveRunRow, 'id' | 'user_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('api_live_runs', id, patch);
    },
    async deleteApiLiveRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM api_live_runs WHERE id = $1', [id]);
    },

    // ─── live_run_steps ──────────────────────────────────────────────────────
    async listLiveRunSteps(opts: { runId?: string; meshId?: string; agentId?: string } = {}): Promise<LiveRunStepRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.runId)   { where.push(`run_id = $${params.length + 1}`);   params.push(opts.runId); }
      if (opts.meshId)  { where.push(`mesh_id = $${params.length + 1}`);  params.push(opts.meshId); }
      if (opts.agentId) { where.push(`agent_id = $${params.length + 1}`); params.push(opts.agentId); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await ctx.query(`SELECT * FROM live_run_steps ${whereSql} ORDER BY created_at COLLATE "C" ASC`, params);
      return rows as unknown as LiveRunStepRow[];
    },
    async getLiveRunStep(id: string): Promise<LiveRunStepRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_run_steps WHERE id = $1', [id]);
      return (rows[0] as LiveRunStepRow | undefined) ?? null;
    },
    async createLiveRunStep(row: Omit<LiveRunStepRow, 'created_at' | 'updated_at'>): Promise<LiveRunStepRow> {
      await ctx.query(
        `INSERT INTO live_run_steps (id, run_id, mesh_id, agent_id, role_key, status, started_at, completed_at, summary, payload_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [row.id, row.run_id, row.mesh_id, row.agent_id, row.role_key, row.status, row.started_at, row.completed_at, row.summary, row.payload_json],
      );
      const { rows } = await ctx.query('SELECT * FROM live_run_steps WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveRunStepRow;
    },
    async updateLiveRunStep(id: string, patch: Partial<Omit<LiveRunStepRow, 'id' | 'run_id' | 'mesh_id' | 'created_at'>>): Promise<void> {
      await buildUpdate('live_run_steps', id, patch);
    },
    async deleteLiveRunStep(id: string): Promise<void> {
      await ctx.query('DELETE FROM live_run_steps WHERE id = $1', [id]);
    },

    // ─── live_run_events (append-only) ───────────────────────────────────────
    async listLiveRunEvents(opts: { runId?: string; afterId?: string; limit?: number } = {}): Promise<LiveRunEventRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.runId)   { where.push(`run_id = $${params.length + 1}`); params.push(opts.runId); }
      if (opts.afterId) { where.push(`id > $${params.length + 1}`);     params.push(opts.afterId); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limitSql  = opts.limit ? `LIMIT ${Number(opts.limit)}` : 'LIMIT 500';
      const { rows } = await ctx.query(`SELECT * FROM live_run_events ${whereSql} ORDER BY id COLLATE "C" ASC ${limitSql}`, params);
      return rows as unknown as LiveRunEventRow[];
    },
    async getLiveRunEvent(id: string): Promise<LiveRunEventRow | null> {
      const { rows } = await ctx.query('SELECT * FROM live_run_events WHERE id = $1', [id]);
      return (rows[0] as LiveRunEventRow | undefined) ?? null;
    },
    async appendLiveRunEvent(row: Omit<LiveRunEventRow, 'created_at'>): Promise<LiveRunEventRow> {
      await ctx.query(
        `INSERT INTO live_run_events (id, run_id, step_id, kind, agent_id, tool_key, summary, payload_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.id, row.run_id, row.step_id, row.kind, row.agent_id, row.tool_key, row.summary, row.payload_json],
      );
      const { rows } = await ctx.query('SELECT * FROM live_run_events WHERE id = $1', [row.id]);
      return rows[0] as unknown as LiveRunEventRow;
    },
  };
}
