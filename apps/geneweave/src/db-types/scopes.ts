/**
 * GeneWeave — db-types/scopes.ts
 *
 * TypeScript interfaces for the scope isolation tables introduced in m75.
 */

/** Row shape for the `agent_scopes` table. */
export interface AgentScopeRow {
  id: string;
  display_name: string;
  description: string;
  sandboxed: number;           // 1 = strict enforcement, 0 = audit-only
  max_delegation_depth: number;
  audit_level: string;         // 'none' | 'log' | 'alert'
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Row shape for the `scope_cross_policies` table. */
export interface ScopeCrossPolicyRow {
  id: string;
  from_scope: string;
  to_scope: string;            // '*' = wildcard
  allowed: number;             // 1 = allowed, 0 = denied
  requires_a2a: number;        // 1 = must use A2A protocol
  max_delegation_depth: number;
  conditions_json: string | null;
  audit_level: string;
  enabled: number;
  created_at: string;
}

/** Row shape for the `scope_skill_assignments` table. */
export interface ScopeSkillAssignmentRow {
  scope_id: string;
  skill_id: string;
}

/** Row shape for the `scope_live_agent_assignments` table. */
export interface ScopeLiveAgentAssignmentRow {
  scope_id: string;
  mesh_key: string;
  role_key: string;           // '' = all roles (catch-all), otherwise a specific role key
}

/** Row shape for the `scope_access_log` table (append-only). */
export interface ScopeAccessLogRow {
  id: string;
  event_type: string;         // 'skill_activation' | 'cross_scope_delegation' | 'tool_invocation' | 'violation'
  from_scope: string | null;
  to_scope: string | null;
  skill_id: string | null;
  tool_name: string | null;
  session_id: string | null;
  task_id: string | null;
  user_id: string | null;
  allowed: number;            // 1 = permitted, 0 = blocked
  reason: string | null;
  delegation_chain_json: string | null;
  created_at: string;
}
