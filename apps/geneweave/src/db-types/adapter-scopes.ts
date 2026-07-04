/**
 * GeneWeave — db-types/adapter-scopes.ts
 *
 * Database adapter methods for the scope isolation tables (m75).
 * Mixed into SQLiteAdapter via the adapter composition pattern used throughout geneweave.
 */
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  AgentScopeRow,
  ScopeCrossPolicyRow,
  ScopeSkillAssignmentRow,
  ScopeLiveAgentAssignmentRow,
  ScopeAccessLogRow,
} from './scopes.js';

/** Assignment row augmented with a synthetic composite ID for admin CRUD. */
export type ScopeSkillAssignmentAdminRow = ScopeSkillAssignmentRow & { id: string };
/** Assignment row augmented with a synthetic composite ID for admin CRUD. */
export type ScopeLiveAgentAssignmentAdminRow = ScopeLiveAgentAssignmentRow & { id: string };

export interface ScopesAdapterMethods {
  // ── Runtime reads (enforcement path) ────────────────────────────────────

  /** List all *enabled* scope definitions (runtime use). */
  listScopes(): Promise<AgentScopeRow[]>;

  /** Get a single scope by ID. Returns null if not found. */
  getScope(id: string): Promise<AgentScopeRow | null>;

  /** List all *enabled* cross-scope policies (runtime use). */
  listScopePolicies(): Promise<ScopeCrossPolicyRow[]>;

  /** Returns the scope ID for a given skill ID, or 'system' if not assigned. */
  getScopeForSkill(skillId: string): Promise<string>;

  /** Returns the scope ID for a given live agent mesh + role, or 'system' if not assigned. */
  getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string>;

  /**
   * Appends a row to the immutable scope_access_log.
   * Never call UPDATE or DELETE on this table.
   */
  logScopeEvent(event: Omit<ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void>;

  /** Returns recent scope access log entries (most recent first). */
  listScopeAccessLog(opts?: {
    limit?: number;
    sessionId?: string;
    onlyViolations?: boolean;
  }): Promise<ScopeAccessLogRow[]>;

  /** Returns the count of scope violations in the last N hours. */
  countScopeViolations(withinHours?: number): Promise<number>;

  /**
   * Returns the agentic_scope for a tool looked up by name OR tool_key.
   * Returns 'system' when no matching catalog entry is found (builtin utilities).
   * Added in m76.
   */
  getScopeForTool(nameOrKey: string): Promise<string>;

  // ── Admin CRUD — agent_scopes ────────────────────────────────────────────

  /** List ALL scope definitions (including disabled) for admin UI. */
  adminListScopes(): Promise<AgentScopeRow[]>;

  /** Create a new scope definition. */
  adminCreateScope(scope: Omit<AgentScopeRow, 'created_at' | 'updated_at'>): Promise<void>;

  /** Update an existing scope definition. */
  adminUpdateScope(id: string, patch: Partial<Omit<AgentScopeRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;

  /** Delete a scope definition. */
  adminDeleteScope(id: string): Promise<void>;

  // ── Admin CRUD — scope_cross_policies ────────────────────────────────────

  /** List ALL cross-scope policies (including disabled) for admin UI. */
  adminListScopePolicies(): Promise<ScopeCrossPolicyRow[]>;

  /** Get a single cross-scope policy by its UUID. */
  adminGetScopePolicy(id: string): Promise<ScopeCrossPolicyRow | null>;

  /** Create a new cross-scope policy. */
  adminCreateScopePolicy(policy: Omit<ScopeCrossPolicyRow, 'created_at'>): Promise<void>;

  /** Update an existing cross-scope policy. */
  adminUpdateScopePolicy(id: string, patch: Partial<Omit<ScopeCrossPolicyRow, 'id' | 'created_at'>>): Promise<void>;

  /** Delete a cross-scope policy. */
  adminDeleteScopePolicy(id: string): Promise<void>;

  // ── Admin CRUD — scope_skill_assignments ─────────────────────────────────

  /**
   * List all skill→scope assignments.
   * Each row is augmented with a synthetic `id` = `{scope_id}::{skill_id}` so
   * the generic admin SPA can treat it like a normal record.
   */
  adminListScopeSkillAssignments(): Promise<ScopeSkillAssignmentAdminRow[]>;

  /** Assign a skill to a scope. Silently no-ops if already assigned. */
  adminCreateScopeSkillAssignment(scope_id: string, skill_id: string): Promise<void>;

  /** Remove a skill→scope assignment by its synthetic composite ID. */
  adminDeleteScopeSkillAssignment(compositeId: string): Promise<void>;

  // ── Admin CRUD — scope_live_agent_assignments ─────────────────────────────

  /**
   * List all live-mesh→scope assignments.
   * Each row is augmented with a synthetic `id` = `{scope_id}::{mesh_key}::{role_key}`.
   */
  adminListScopeLiveAgentAssignments(): Promise<ScopeLiveAgentAssignmentAdminRow[]>;

  /** Assign a live agent mesh+role to a scope. */
  adminCreateScopeLiveAgentAssignment(scope_id: string, mesh_key: string, role_key: string): Promise<void>;

  /** Remove a live-mesh→scope assignment by its synthetic composite ID. */
  adminDeleteScopeLiveAgentAssignment(compositeId: string): Promise<void>;
}

/**
 * Builds the adapter methods. Call this from the SQLiteAdapter class body,
 * passing `this.raw` (the BetterSqlite3.Database instance).
 */
export function buildScopesAdapter(raw: BetterSqlite3.Database): ScopesAdapterMethods {
  return {
    async listScopes(): Promise<AgentScopeRow[]> {
      return raw.prepare(`
        SELECT * FROM agent_scopes WHERE enabled = 1 ORDER BY id
      `).all() as AgentScopeRow[];
    },

    async getScope(id: string): Promise<AgentScopeRow | null> {
      return (raw.prepare(`
        SELECT * FROM agent_scopes WHERE id = ?
      `).get(id) as AgentScopeRow | undefined) ?? null;
    },

    async listScopePolicies(): Promise<ScopeCrossPolicyRow[]> {
      return raw.prepare(`
        SELECT * FROM scope_cross_policies WHERE enabled = 1
        ORDER BY from_scope, to_scope
      `).all() as ScopeCrossPolicyRow[];
    },

    async getScopeForSkill(skillId: string): Promise<string> {
      // First try the skill-level override in scope_skill_assignments
      const row = raw.prepare(`
        SELECT scope_id FROM scope_skill_assignments WHERE skill_id = ?
      `).get(skillId) as { scope_id: string } | undefined;
      if (row) return row.scope_id;

      // Then try the agentic_scope column on a2a_skills
      const skillRow = raw.prepare(`
        SELECT agentic_scope FROM a2a_skills WHERE id = ?
      `).get(skillId) as { agentic_scope: string } | undefined;
      if (skillRow?.agentic_scope) return skillRow.agentic_scope;

      // Default: 'system' (most permissive, treated as a shared utility scope)
      return 'system';
    },

    async getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string> {
      // Check for specific role assignment first, fall back to catch-all ('' role_key)
      const row = raw.prepare(`
        SELECT scope_id FROM scope_live_agent_assignments
        WHERE mesh_key = ? AND role_key IN (?, '')
        ORDER BY CASE role_key WHEN ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(meshKey, roleKey, roleKey) as { scope_id: string } | undefined;
      return row?.scope_id ?? 'system';
    },

    async logScopeEvent(event: Omit<ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void> {
      const id = randomUUID();
      raw.prepare(`
        INSERT INTO scope_access_log
          (id, event_type, from_scope, to_scope, skill_id, tool_name,
           session_id, task_id, user_id, allowed, reason, delegation_chain_json)
        VALUES
          (@id, @event_type, @from_scope, @to_scope, @skill_id, @tool_name,
           @session_id, @task_id, @user_id, @allowed, @reason, @delegation_chain_json)
      `).run({ id, ...event });
    },

    async listScopeAccessLog(opts = {}): Promise<ScopeAccessLogRow[]> {
      const limit = opts.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.sessionId) {
        conditions.push('session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.onlyViolations) {
        conditions.push('allowed = 0');
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      return raw.prepare(`
        SELECT * FROM scope_access_log ${where} ORDER BY created_at DESC LIMIT ?
      `).all(...params) as ScopeAccessLogRow[];
    },

    async countScopeViolations(withinHours = 24): Promise<number> {
      const since = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
      const row = raw.prepare(`
        SELECT COUNT(*) as n FROM scope_access_log
        WHERE allowed = 0 AND created_at >= ?
      `).get(since) as { n: number };
      return row.n;
    },

    async getScopeForTool(nameOrKey: string): Promise<string> {
      const row = raw.prepare(
        `SELECT agentic_scope FROM tool_catalog WHERE (tool_key = ? OR name = ?) AND enabled = 1 LIMIT 1`,
      ).get(nameOrKey, nameOrKey) as { agentic_scope?: string } | undefined;
      return row?.agentic_scope ?? 'system';
    },

    // ── Admin CRUD — agent_scopes ──────────────────────────────────────────

    async adminListScopes(): Promise<AgentScopeRow[]> {
      return raw.prepare(`SELECT * FROM agent_scopes ORDER BY id`).all() as AgentScopeRow[];
    },

    async adminCreateScope(scope: Omit<AgentScopeRow, 'created_at' | 'updated_at'>): Promise<void> {
      raw.prepare(`
        INSERT INTO agent_scopes (id, display_name, description, sandboxed, max_delegation_depth, audit_level, enabled)
        VALUES (@id, @display_name, @description, @sandboxed, @max_delegation_depth, @audit_level, @enabled)
      `).run(scope);
    },

    async adminUpdateScope(id: string, patch: Partial<Omit<AgentScopeRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      const setClauses = [...cols.map((c) => `${c} = @${c}`), `updated_at = datetime('now')`].join(', ');
      raw.prepare(`UPDATE agent_scopes SET ${setClauses} WHERE id = @id`).run({ ...patch, id });
    },

    async adminDeleteScope(id: string): Promise<void> {
      raw.prepare(`DELETE FROM agent_scopes WHERE id = ?`).run(id);
    },

    // ── Admin CRUD — scope_cross_policies ──────────────────────────────────

    async adminListScopePolicies(): Promise<ScopeCrossPolicyRow[]> {
      return raw.prepare(`SELECT * FROM scope_cross_policies ORDER BY from_scope, to_scope`).all() as ScopeCrossPolicyRow[];
    },

    async adminGetScopePolicy(id: string): Promise<ScopeCrossPolicyRow | null> {
      return (raw.prepare(`SELECT * FROM scope_cross_policies WHERE id = ?`).get(id) as ScopeCrossPolicyRow | undefined) ?? null;
    },

    async adminCreateScopePolicy(policy: Omit<ScopeCrossPolicyRow, 'created_at'>): Promise<void> {
      raw.prepare(`
        INSERT INTO scope_cross_policies
          (id, from_scope, to_scope, allowed, requires_a2a, max_delegation_depth, conditions_json, audit_level, enabled)
        VALUES
          (@id, @from_scope, @to_scope, @allowed, @requires_a2a, @max_delegation_depth, @conditions_json, @audit_level, @enabled)
      `).run(policy);
    },

    async adminUpdateScopePolicy(id: string, patch: Partial<Omit<ScopeCrossPolicyRow, 'id' | 'created_at'>>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      const setClauses = cols.map((c) => `${c} = @${c}`).join(', ');
      raw.prepare(`UPDATE scope_cross_policies SET ${setClauses} WHERE id = @id`).run({ ...patch, id });
    },

    async adminDeleteScopePolicy(id: string): Promise<void> {
      raw.prepare(`DELETE FROM scope_cross_policies WHERE id = ?`).run(id);
    },

    // ── Admin CRUD — scope_skill_assignments ───────────────────────────────

    async adminListScopeSkillAssignments(): Promise<ScopeSkillAssignmentAdminRow[]> {
      const rows = raw.prepare(`
        SELECT scope_id, skill_id FROM scope_skill_assignments ORDER BY scope_id, skill_id
      `).all() as import('./scopes.js').ScopeSkillAssignmentRow[];
      return rows.map((r) => ({ ...r, id: `${r.scope_id}::${r.skill_id}` }));
    },

    async adminCreateScopeSkillAssignment(scope_id: string, skill_id: string): Promise<void> {
      raw.prepare(`INSERT OR IGNORE INTO scope_skill_assignments (scope_id, skill_id) VALUES (?, ?)`).run(scope_id, skill_id);
    },

    async adminDeleteScopeSkillAssignment(compositeId: string): Promise<void> {
      const sep = compositeId.indexOf('::');
      if (sep === -1) throw new Error(`Invalid compositeId: ${compositeId}`);
      const scope_id = compositeId.slice(0, sep);
      const skill_id = compositeId.slice(sep + 2);
      raw.prepare(`DELETE FROM scope_skill_assignments WHERE scope_id = ? AND skill_id = ?`).run(scope_id, skill_id);
    },

    // ── Admin CRUD — scope_live_agent_assignments ──────────────────────────

    async adminListScopeLiveAgentAssignments(): Promise<ScopeLiveAgentAssignmentAdminRow[]> {
      const rows = raw.prepare(`
        SELECT scope_id, mesh_key, role_key FROM scope_live_agent_assignments ORDER BY scope_id, mesh_key, role_key
      `).all() as import('./scopes.js').ScopeLiveAgentAssignmentRow[];
      return rows.map((r) => ({ ...r, id: `${r.scope_id}::${r.mesh_key}::${r.role_key}` }));
    },

    async adminCreateScopeLiveAgentAssignment(scope_id: string, mesh_key: string, role_key: string): Promise<void> {
      raw.prepare(
        `INSERT OR IGNORE INTO scope_live_agent_assignments (scope_id, mesh_key, role_key) VALUES (?, ?, ?)`,
      ).run(scope_id, mesh_key, role_key);
    },

    async adminDeleteScopeLiveAgentAssignment(compositeId: string): Promise<void> {
      const parts = compositeId.split('::');
      if (parts.length < 3) throw new Error(`Invalid compositeId: ${compositeId}`);
      const [scope_id, mesh_key, ...rest] = parts;
      const role_key = rest.join('::');
      raw.prepare(
        `DELETE FROM scope_live_agent_assignments WHERE scope_id = ? AND mesh_key = ? AND role_key = ?`,
      ).run(scope_id, mesh_key, role_key);
    },
  };
}
