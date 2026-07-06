// SPDX-License-Identifier: MIT
/**
 * Postgres store for the `IAgentStore` slice of `DatabaseAdapter` — worker agents, supervisor
 * agents (+ their `agent_tools`), workflow runs & checkpoints, capability policy bindings, agent
 * strategy settings, and HITL interrupt requests.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` byte-for-byte: identical SQL, same
 * statement order, same return shapes. SQLite-isms are translated per the porting convention —
 * `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte order), and
 * `INSERT OR REPLACE`→`ON CONFLICT (...) DO UPDATE`. Booleans are INTEGER 0/1; JSON columns are TEXT
 * pass-through; every value is a bound parameter.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  WorkerAgentRow,
  SupervisorAgentRow,
  AgentToolRow,
  ResolvedSupervisorAgent,
  AgentStrategySettingsRow,
} from '../db-types/agents.js';
import type { WorkflowRunRow, WorkflowCheckpointRow, CapabilityPolicyBindingRow } from '../db-types/workflows.js';

/** ISO-8601-with-millis UTC text, matching SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. */
const NOW_ISO_MS = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function pgAgentStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Worker Agents ───────────────────────────────────────────────────────
    async createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          w.id,
          w.name,
          w.display_name ?? null,
          w.job_profile ?? null,
          w.description,
          w.system_prompt,
          w.tool_names,
          w.persona,
          w.trigger_patterns ?? null,
          w.task_contract_id ?? null,
          w.max_retries,
          w.priority,
          w.category ?? 'general',
          w.enabled,
        ],
      );
    },

    async getWorkerAgent(id: string): Promise<WorkerAgentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM worker_agents WHERE id = $1', [id]);
      return (rows[0] as WorkerAgentRow | undefined) ?? null;
    },

    async listWorkerAgents(): Promise<WorkerAgentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM worker_agents ORDER BY priority DESC, COALESCE(display_name, name) COLLATE "C" ASC');
      return rows as unknown as WorkerAgentRow[];
    },

    async listEnabledWorkerAgents(): Promise<WorkerAgentRow[]> {
      const { rows } = await ctx.query(`SELECT * FROM worker_agents WHERE enabled = 1 AND category = 'general' ORDER BY priority DESC, COALESCE(display_name, name) COLLATE "C" ASC`);
      return rows as unknown as WorkerAgentRow[];
    },

    async listWorkerAgentsByCategory(category: string): Promise<WorkerAgentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM worker_agents WHERE enabled = 1 AND category = $1 ORDER BY priority DESC, COALESCE(display_name, name) COLLATE "C" ASC', [category]);
      return rows as unknown as WorkerAgentRow[];
    },

    async updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE worker_agents SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteWorkerAgent(id: string): Promise<void> {
      await ctx.query('DELETE FROM worker_agents WHERE id = $1', [id]);
    },

    // ─── Phase 1B: Supervisor Agents ─────────────────────────────────────────
    async createSupervisorAgent(
      a: Omit<SupervisorAgentRow, 'created_at' | 'updated_at'>,
      tools?: Array<{ tool_name: string; allocation?: string }>,
    ): Promise<void> {
      await ctx.query(
        `INSERT INTO agents (id, tenant_id, category, name, display_name, description, system_prompt, include_utility_tools, default_timezone, is_default, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          a.id,
          a.tenant_id,
          a.category,
          a.name,
          a.display_name,
          a.description,
          a.system_prompt,
          a.include_utility_tools,
          a.default_timezone,
          a.is_default,
          a.enabled,
        ],
      );
      if (tools && tools.length > 0) {
        for (const t of tools) {
          await ctx.query(
            `INSERT INTO agent_tools (agent_id, tool_name, allocation) VALUES ($1, $2, $3)
             ON CONFLICT (agent_id, tool_name) DO UPDATE SET allocation = EXCLUDED.allocation`,
            [a.id, t.tool_name, t.allocation ?? 'default'],
          );
        }
      }
    },

    async getSupervisorAgent(id: string): Promise<SupervisorAgentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM agents WHERE id = $1', [id]);
      return (rows[0] as SupervisorAgentRow | undefined) ?? null;
    },

    async listSupervisorAgents(opts?: { tenantId?: string | null; category?: string; enabledOnly?: boolean }): Promise<SupervisorAgentRow[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.enabledOnly) where.push('enabled = 1');
      if (opts?.category) { where.push(`category = $${args.length + 1}`); args.push(opts.category); }
      if (opts?.tenantId === null) where.push('tenant_id IS NULL');
      else if (typeof opts?.tenantId === 'string') { where.push(`tenant_id = $${args.length + 1}`); args.push(opts.tenantId); }
      const sql = where.length
        ? `SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY is_default DESC, name COLLATE "C" ASC`
        : 'SELECT * FROM agents ORDER BY is_default DESC, name COLLATE "C" ASC';
      const { rows } = await ctx.query(sql, args);
      return rows as unknown as SupervisorAgentRow[];
    },

    async updateSupervisorAgent(id: string, fields: Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE agents SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteSupervisorAgent(id: string): Promise<void> {
      await ctx.query('DELETE FROM agents WHERE id = $1', [id]);
    },

    async listAgentTools(agentId: string): Promise<AgentToolRow[]> {
      const { rows } = await ctx.query('SELECT agent_id, tool_name, allocation FROM agent_tools WHERE agent_id = $1 ORDER BY tool_name COLLATE "C" ASC', [agentId]);
      return rows as unknown as AgentToolRow[];
    },

    async setAgentTools(agentId: string, tools: Array<{ tool_name: string; allocation?: string }>): Promise<void> {
      await ctx.query('DELETE FROM agent_tools WHERE agent_id = $1', [agentId]);
      for (const t of tools) {
        await ctx.query('INSERT INTO agent_tools (agent_id, tool_name, allocation) VALUES ($1, $2, $3)', [agentId, t.tool_name, t.allocation ?? 'default']);
      }
    },

    async resolveSupervisorAgent(opts: { tenantId?: string | null; category?: string; skillId?: string | null }): Promise<ResolvedSupervisorAgent | null> {
      const category = opts.category ?? 'general';
      const tenantId = opts.tenantId ?? null;

      const fetchWithTools = async (agent: SupervisorAgentRow): Promise<ResolvedSupervisorAgent> => {
        const { rows } = await ctx.query('SELECT agent_id, tool_name, allocation FROM agent_tools WHERE agent_id = $1', [agent.id]);
        return { agent, tools: rows as unknown as AgentToolRow[] };
      };

      // 1. skill.supervisor_agent_id pin
      if (opts.skillId) {
        const { rows: skillRows } = await ctx.query('SELECT supervisor_agent_id FROM skills WHERE id = $1', [opts.skillId]);
        const skill = skillRows[0] as unknown as { supervisor_agent_id: string | null } | undefined;
        if (skill?.supervisor_agent_id) {
          const { rows } = await ctx.query('SELECT * FROM agents WHERE id = $1 AND enabled = 1', [skill.supervisor_agent_id]);
          const a = rows[0] as SupervisorAgentRow | undefined;
          if (a) return fetchWithTools(a);
        }
      }

      // 2. tenant_id + category exact match
      if (tenantId) {
        const { rows } = await ctx.query('SELECT * FROM agents WHERE tenant_id = $1 AND category = $2 AND enabled = 1 ORDER BY is_default DESC LIMIT 1', [tenantId, category]);
        const a = rows[0] as SupervisorAgentRow | undefined;
        if (a) return fetchWithTools(a);
      }

      // 3. global (tenant_id IS NULL) + category match
      const { rows: globalRows } = await ctx.query('SELECT * FROM agents WHERE tenant_id IS NULL AND category = $1 AND enabled = 1 ORDER BY is_default DESC LIMIT 1', [category]);
      const globalCategoryMatch = globalRows[0] as unknown as SupervisorAgentRow | undefined;
      if (globalCategoryMatch) return fetchWithTools(globalCategoryMatch);

      // 4. is_default fallback (any category)
      const { rows: defaultRows } = await ctx.query('SELECT * FROM agents WHERE is_default = 1 AND enabled = 1 ORDER BY tenant_id IS NULL ASC LIMIT 1');
      const defaultRow = defaultRows[0] as unknown as SupervisorAgentRow | undefined;
      if (defaultRow) return fetchWithTools(defaultRow);

      return null;
    },

    // ─── Workflow Runs ───────────────────────────────────────────────────────
    async createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO workflow_runs (id, workflow_id, status, state, input, error, started_at, cost_total, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.workflow_id, r.status, r.state, r.input, r.error, r.started_at, r.cost_total ?? 0, r.metadata ?? null],
      );
    },

    async getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM workflow_runs WHERE id = $1', [id]);
      return (rows[0] as WorkflowRunRow | undefined) ?? null;
    },

    async listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]> {
      if (workflowId) {
        const { rows } = await ctx.query('SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at COLLATE "C" DESC', [workflowId]);
        return rows as unknown as WorkflowRunRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM workflow_runs ORDER BY started_at COLLATE "C" DESC');
      return rows as unknown as WorkflowRunRow[];
    },

    async updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      vals.push(id);
      await ctx.query(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteWorkflowRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM workflow_runs WHERE id = $1', [id]);
    },

    // ─── Phase 5: Workflow Checkpoints ───────────────────────────────────────
    async createWorkflowCheckpoint(c: Omit<WorkflowCheckpointRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO workflow_checkpoints (id, run_id, workflow_id, step_id, state) VALUES ($1, $2, $3, $4, $5)`,
        [c.id, c.run_id, c.workflow_id, c.step_id, c.state],
      );
    },

    async listWorkflowCheckpoints(runId: string): Promise<WorkflowCheckpointRow[]> {
      // SQLite tiebreaks on rowid (insertion order); Postgres has no rowid, so we fall back to the
      // primary key `id` for a stable, deterministic secondary sort.
      const { rows } = await ctx.query('SELECT * FROM workflow_checkpoints WHERE run_id = $1 ORDER BY created_at COLLATE "C" ASC, id COLLATE "C" ASC', [runId]);
      return rows as unknown as WorkflowCheckpointRow[];
    },

    async deleteWorkflowCheckpoints(runId: string): Promise<void> {
      await ctx.query('DELETE FROM workflow_checkpoints WHERE run_id = $1', [runId]);
    },

    // ─── Phase 5: Capability Policy Bindings ─────────────────────────────────
    async createCapabilityPolicyBinding(b: Omit<CapabilityPolicyBindingRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO capability_policy_bindings (id, binding_kind, binding_ref, policy_kind, policy_ref, precedence, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [b.id, b.binding_kind, b.binding_ref, b.policy_kind, b.policy_ref, b.precedence, b.enabled],
      );
    },

    async getCapabilityPolicyBinding(id: string): Promise<CapabilityPolicyBindingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM capability_policy_bindings WHERE id = $1', [id]);
      return (rows[0] as CapabilityPolicyBindingRow | undefined) ?? null;
    },

    async listCapabilityPolicyBindings(opts?: { bindingKind?: string; bindingRef?: string; policyKind?: string; enabledOnly?: boolean }): Promise<CapabilityPolicyBindingRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.bindingKind) { wheres.push(`binding_kind = $${vals.length + 1}`); vals.push(opts.bindingKind); }
      if (opts?.bindingRef) { wheres.push(`binding_ref = $${vals.length + 1}`); vals.push(opts.bindingRef); }
      if (opts?.policyKind) { wheres.push(`policy_kind = $${vals.length + 1}`); vals.push(opts.policyKind); }
      if (opts?.enabledOnly) { wheres.push('enabled = 1'); }
      const sql = `SELECT * FROM capability_policy_bindings ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY precedence DESC, created_at COLLATE "C" ASC`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as CapabilityPolicyBindingRow[];
    },

    async updateCapabilityPolicyBinding(id: string, fields: Partial<Omit<CapabilityPolicyBindingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE capability_policy_bindings SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCapabilityPolicyBinding(id: string): Promise<void> {
      await ctx.query('DELETE FROM capability_policy_bindings WHERE id = $1', [id]);
    },

    // ─── Agent Strategy Settings (Phase 7 / m74) ─────────────────────────────
    async getAgentStrategySettings(id: string): Promise<AgentStrategySettingsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM agent_strategy_settings WHERE id = $1', [id]);
      return (rows[0] as AgentStrategySettingsRow | undefined) ?? null;
    },

    async listAgentStrategySettings(): Promise<AgentStrategySettingsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM agent_strategy_settings ORDER BY scope COLLATE "C" ASC, id COLLATE "C" ASC');
      return rows as unknown as AgentStrategySettingsRow[];
    },

    async updateAgentStrategySettings(id: string, patch: Partial<Omit<AgentStrategySettingsRow, 'id' | 'updated_at'>>): Promise<void> {
      const fields = Object.keys(patch) as Array<keyof typeof patch>;
      if (fields.length === 0) return;
      const setClauses = fields.map((f, i) => `${String(f)} = $${i + 1}`).join(', ');
      const values = fields.map((f) => patch[f] ?? null);
      await ctx.query(`UPDATE agent_strategy_settings SET ${setClauses}, updated_at = ${ctx.now} WHERE id = $${values.length + 1}`, [...values, id]);
    },

    // ─── HITL interrupt requests (m64 / m93) ─────────────────────────────────
    async createHitlInterrupt(row: {
      id: string; chat_id: string; run_id?: string | null; agent_name: string; agent_step?: number;
      tool_name: string; tool_args_json?: string; interrupt_type?: string; reason?: string; expires_at?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO hitl_interrupt_requests
           (id, chat_id, run_id, agent_name, agent_step, tool_name, tool_args_json, interrupt_type, reason, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.chat_id, row.run_id ?? null, row.agent_name, row.agent_step ?? 0,
          row.tool_name, row.tool_args_json ?? '{}', row.interrupt_type ?? 'tool_approval', row.reason ?? '', row.expires_at ?? null,
        ],
      );
    },

    async resolveHitlInterrupt(id: string, fields: {
      status: string; decision_action?: string; modified_args_json?: string | null; feedback?: string | null; decided_by?: string | null;
    }): Promise<void> {
      await ctx.query(
        `UPDATE hitl_interrupt_requests
           SET status = $1, decision_action = $2, modified_args_json = $3, feedback = $4, decided_by = $5, decided_at = ${NOW_ISO_MS}
         WHERE id = $6`,
        [fields.status, fields.decision_action ?? null, fields.modified_args_json ?? null, fields.feedback ?? null, fields.decided_by ?? null, id],
      );
    },

    async listPendingHitlInterruptsByRun(runId: string): Promise<Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>> {
      const { rows } = await ctx.query(
        `SELECT id, tool_name, status, tool_args_json FROM hitl_interrupt_requests WHERE run_id = $1 AND status = 'pending' ORDER BY created_at COLLATE "C" ASC`,
        [runId],
      );
      return rows as unknown as Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>;
    },
  };
}
