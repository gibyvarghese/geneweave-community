// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `ScopesAdapterMethods` domain slice (scope isolation tables, m75/m76) of the
 * geneWeave `DatabaseAdapter`.
 *
 * Mirrors the SQLite implementation (`buildScopesAdapter` in `../db-types/adapter-scopes.ts`, mixed
 * into `SQLiteAdapter`) statement-for-statement: same SQL, same column order, same integer-boolean
 * and TEXT-JSON conventions, same return shapes. The only translations are SQLite→Postgres dialect
 * differences:
 *   - `?` / `@named` placeholders → `$1, $2, …` positional params (all values bound, never inlined)
 *   - `datetime('now')` → `${ctx.now}` (splices the shared NOW_SQL expression)
 *   - TEXT `ORDER BY` → `COLLATE "C"` to preserve SQLite's byte-order sort parity
 *   - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
 * Booleans stay INTEGER 0/1; JSON columns stay TEXT pass-through.
 */
import { randomUUID } from 'node:crypto';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  AgentScopeRow,
  ScopeCrossPolicyRow,
  ScopeSkillAssignmentRow,
  ScopeLiveAgentAssignmentRow,
  ScopeAccessLogRow,
} from '../db-types/scopes.js';
import type {
  ScopesAdapterMethods,
  ScopeSkillAssignmentAdminRow,
  ScopeLiveAgentAssignmentAdminRow,
} from '../db-types/adapter-scopes.js';

export function pgScopesStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  // Compile-time guard: this object must implement EVERY ScopesAdapterMethods method with the
  // exact signatures. Typed as the full interface here (not Partial) so a missing/mistyped method
  // is a build error; returned as Partial<DatabaseAdapter> to match the domain-store contract.
  const store: ScopesAdapterMethods = {
    // ── Runtime reads (enforcement path) ────────────────────────────────────

    async listScopes(): Promise<AgentScopeRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM agent_scopes WHERE enabled = 1 ORDER BY id COLLATE "C"`,
        [],
      );
      return rows as unknown as AgentScopeRow[];
    },

    async getScope(id: string): Promise<AgentScopeRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM agent_scopes WHERE id = $1`, [id]);
      return (rows[0] as AgentScopeRow | undefined) ?? null;
    },

    async listScopePolicies(): Promise<ScopeCrossPolicyRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM scope_cross_policies WHERE enabled = 1
         ORDER BY from_scope COLLATE "C", to_scope COLLATE "C"`,
        [],
      );
      return rows as unknown as ScopeCrossPolicyRow[];
    },

    async getScopeForSkill(skillId: string): Promise<string> {
      // First try the skill-level override in scope_skill_assignments
      const { rows: assignRows } = await ctx.query(
        `SELECT scope_id FROM scope_skill_assignments WHERE skill_id = $1`,
        [skillId],
      );
      const row = assignRows[0] as { scope_id: string } | undefined;
      if (row) return row.scope_id;

      // Then try the agentic_scope column on a2a_skills; default 'system'.
      const { rows: skillRows } = await ctx.query(
        `SELECT agentic_scope FROM a2a_skills WHERE id = $1`,
        [skillId],
      );
      const skillRow = skillRows[0] as { agentic_scope: string } | undefined;
      return skillRow?.agentic_scope ?? 'system';
    },

    async getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string> {
      // Check for specific role assignment first, fall back to catch-all ('' role_key)
      const { rows } = await ctx.query(
        `SELECT scope_id FROM scope_live_agent_assignments
         WHERE mesh_key = $1 AND role_key IN ($2, '')
         ORDER BY CASE role_key WHEN $3 THEN 0 ELSE 1 END
         LIMIT 1`,
        [meshKey, roleKey, roleKey],
      );
      const row = rows[0] as { scope_id: string } | undefined;
      return row?.scope_id ?? 'system';
    },

    async logScopeEvent(event: Omit<ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void> {
      const id = randomUUID();
      await ctx.query(
        `INSERT INTO scope_access_log
           (id, event_type, from_scope, to_scope, skill_id, tool_name,
            session_id, task_id, user_id, allowed, reason, delegation_chain_json)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          event.event_type,
          event.from_scope,
          event.to_scope,
          event.skill_id,
          event.tool_name,
          event.session_id,
          event.task_id,
          event.user_id,
          event.allowed,
          event.reason,
          event.delegation_chain_json,
        ],
      );
    },

    async listScopeAccessLog(opts: { limit?: number; sessionId?: string; onlyViolations?: boolean } = {}): Promise<ScopeAccessLogRow[]> {
      const limit = opts.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.sessionId) {
        params.push(opts.sessionId);
        conditions.push(`session_id = $${params.length}`);
      }
      if (opts.onlyViolations) {
        conditions.push('allowed = 0');
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const { rows } = await ctx.query(
        `SELECT * FROM scope_access_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows as unknown as ScopeAccessLogRow[];
    },

    async countScopeViolations(withinHours = 24): Promise<number> {
      // Mirror the SQLite body, which compares against a *space-separated* timestamp string
      // (`datetime('now', '-N hours')`), NOT a JS `.toISOString()` value: the ISO 'T' (0x54)
      // sorts greater than the space (0x20) our created_at uses, so a JS timestamp would make
      // the range check always fail (return 0). Build the same space-format bound in SQL.
      const hours = Math.floor(withinHours);
      const { rows } = await ctx.query(
        `SELECT COUNT(*) as n FROM scope_access_log
         WHERE allowed = 0
           AND created_at >= to_char((now() at time zone 'utc') - interval '${hours} hours', 'YYYY-MM-DD HH24:MI:SS')`,
        [],
      );
      const row = rows[0] as { n: number | string };
      return Number(row.n);
    },

    async getScopeForTool(nameOrKey: string): Promise<string> {
      const { rows } = await ctx.query(
        `SELECT agentic_scope FROM tool_catalog WHERE (tool_key = $1 OR name = $2) AND enabled = 1 LIMIT 1`,
        [nameOrKey, nameOrKey],
      );
      const row = rows[0] as { agentic_scope?: string } | undefined;
      return row?.agentic_scope ?? 'system';
    },

    // ── Admin CRUD — agent_scopes ────────────────────────────────────────────

    async adminListScopes(): Promise<AgentScopeRow[]> {
      const { rows } = await ctx.query(`SELECT * FROM agent_scopes ORDER BY id COLLATE "C"`, []);
      return rows as unknown as AgentScopeRow[];
    },

    async adminCreateScope(scope: Omit<AgentScopeRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO agent_scopes (id, display_name, description, sandboxed, max_delegation_depth, audit_level, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          scope.id,
          scope.display_name,
          scope.description,
          scope.sandboxed,
          scope.max_delegation_depth,
          scope.audit_level,
          scope.enabled,
        ],
      );
    },

    async adminUpdateScope(id: string, patch: Partial<Omit<AgentScopeRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      const params: unknown[] = [];
      const setClauses = cols.map((c) => {
        params.push((patch as Record<string, unknown>)[c]);
        return `${c} = $${params.length}`;
      });
      setClauses.push(`updated_at = ${ctx.now}`);
      params.push(id);
      await ctx.query(
        `UPDATE agent_scopes SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
        params,
      );
    },

    async adminDeleteScope(id: string): Promise<void> {
      await ctx.query(`DELETE FROM agent_scopes WHERE id = $1`, [id]);
    },

    // ── Admin CRUD — scope_cross_policies ────────────────────────────────────

    async adminListScopePolicies(): Promise<ScopeCrossPolicyRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM scope_cross_policies ORDER BY from_scope COLLATE "C", to_scope COLLATE "C"`,
        [],
      );
      return rows as unknown as ScopeCrossPolicyRow[];
    },

    async adminGetScopePolicy(id: string): Promise<ScopeCrossPolicyRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM scope_cross_policies WHERE id = $1`, [id]);
      return (rows[0] as ScopeCrossPolicyRow | undefined) ?? null;
    },

    async adminCreateScopePolicy(policy: Omit<ScopeCrossPolicyRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO scope_cross_policies
           (id, from_scope, to_scope, allowed, requires_a2a, max_delegation_depth, conditions_json, audit_level, enabled)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          policy.id,
          policy.from_scope,
          policy.to_scope,
          policy.allowed,
          policy.requires_a2a,
          policy.max_delegation_depth,
          policy.conditions_json,
          policy.audit_level,
          policy.enabled,
        ],
      );
    },

    async adminUpdateScopePolicy(id: string, patch: Partial<Omit<ScopeCrossPolicyRow, 'id' | 'created_at'>>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      const params: unknown[] = [];
      const setClauses = cols.map((c) => {
        params.push((patch as Record<string, unknown>)[c]);
        return `${c} = $${params.length}`;
      });
      params.push(id);
      await ctx.query(
        `UPDATE scope_cross_policies SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
        params,
      );
    },

    async adminDeleteScopePolicy(id: string): Promise<void> {
      await ctx.query(`DELETE FROM scope_cross_policies WHERE id = $1`, [id]);
    },

    // ── Admin CRUD — scope_skill_assignments ─────────────────────────────────

    async adminListScopeSkillAssignments(): Promise<ScopeSkillAssignmentAdminRow[]> {
      const { rows } = await ctx.query(
        `SELECT scope_id, skill_id FROM scope_skill_assignments ORDER BY scope_id COLLATE "C", skill_id COLLATE "C"`,
        [],
      );
      return (rows as unknown as ScopeSkillAssignmentRow[]).map((r) => ({ ...r, id: `${r.scope_id}::${r.skill_id}` }));
    },

    async adminCreateScopeSkillAssignment(scope_id: string, skill_id: string): Promise<void> {
      await ctx.query(
        `INSERT INTO scope_skill_assignments (scope_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [scope_id, skill_id],
      );
    },

    async adminDeleteScopeSkillAssignment(compositeId: string): Promise<void> {
      const sep = compositeId.indexOf('::');
      if (sep === -1) throw new Error(`Invalid compositeId: ${compositeId}`);
      const scope_id = compositeId.slice(0, sep);
      const skill_id = compositeId.slice(sep + 2);
      await ctx.query(
        `DELETE FROM scope_skill_assignments WHERE scope_id = $1 AND skill_id = $2`,
        [scope_id, skill_id],
      );
    },

    // ── Admin CRUD — scope_live_agent_assignments ─────────────────────────────

    async adminListScopeLiveAgentAssignments(): Promise<ScopeLiveAgentAssignmentAdminRow[]> {
      const { rows } = await ctx.query(
        `SELECT scope_id, mesh_key, role_key FROM scope_live_agent_assignments
         ORDER BY scope_id COLLATE "C", mesh_key COLLATE "C", role_key COLLATE "C"`,
        [],
      );
      return (rows as unknown as ScopeLiveAgentAssignmentRow[]).map((r) => ({
        ...r,
        id: `${r.scope_id}::${r.mesh_key}::${r.role_key}`,
      }));
    },

    async adminCreateScopeLiveAgentAssignment(scope_id: string, mesh_key: string, role_key: string): Promise<void> {
      await ctx.query(
        `INSERT INTO scope_live_agent_assignments (scope_id, mesh_key, role_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [scope_id, mesh_key, role_key],
      );
    },

    async adminDeleteScopeLiveAgentAssignment(compositeId: string): Promise<void> {
      const parts = compositeId.split('::');
      if (parts.length < 3) throw new Error(`Invalid compositeId: ${compositeId}`);
      const [scope_id, mesh_key, ...rest] = parts;
      const role_key = rest.join('::');
      await ctx.query(
        `DELETE FROM scope_live_agent_assignments WHERE scope_id = $1 AND mesh_key = $2 AND role_key = $3`,
        [scope_id, mesh_key, role_key],
      );
    },
  };
  return store;
}
