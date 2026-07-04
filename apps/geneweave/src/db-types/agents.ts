/** Worker agent, supervisor agent, idempotency, and OAuth flow state row types. */

export interface WorkerAgentRow {
  id: string;
  name: string;
  display_name: string | null;
  job_profile: string | null;
  description: string;
  system_prompt: string;
  tool_names: string;            // JSON string[]
  persona: string;
  trigger_patterns: string | null; // JSON string[]
  task_contract_id: string | null;
  max_retries: number;
  priority: number;
  /** Feature grouping: 'general' | 'hypothesis-validation' | other domain categories. */
  category: string;
  /** Scope this worker operates in — matches agent_scopes.id. Added in m76. Defaults to 'system'. */
  agentic_scope?: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 1B — DB-driven supervisor agent definition.
 * Operators register supervisor agents per-tenant and per-category. The
 * runtime resolves which row applies to a chat session and uses it to drive
 * the supervisor's name, system prompt, default timezone, utility-tools
 * inclusion flag, and curated tool bundle (via `agent_tools`).
 */
export interface SupervisorAgentRow {
  id: string;
  /** Null = global default applicable across tenants. */
  tenant_id: string | null;
  /** Routing key — 'general' or domain-scoped (e.g. 'hypothesis-validation'). */
  category: string;
  name: string;
  display_name: string | null;
  description: string | null;
  /** Optional override for supervisor system prompt. Falls back to settings.systemPrompt when null. */
  system_prompt: string | null;
  /** When 1, package-provided datetime/math_eval/unit_convert tools are auto-bound. */
  include_utility_tools: number;
  /** IANA timezone string used by the datetime utility tool. Falls back to settings.timezone. */
  default_timezone: string | null;
  /** When 1, this row is the global fallback agent if nothing else matches. */
  is_default: number;
  enabled: number;
  // ─── Phase 1 anyWeave Task-Aware Routing (optional, additive) ─────
  /** Default task type when none is inferred (e.g. 'reasoning', 'summarization'). */
  default_task_type?: string | null;
  /** JSON string[] — restricts the router to a whitelist of task keys. */
  allowed_task_types?: string | null;
  /** JSON {[taskKey]: {modelId, provider}} — agent-level model preferences per task. */
  preferred_models?: string | null;
  /** Per-call USD ceiling. Router excludes models whose estimated cost exceeds this. */
  cost_ceiling_per_call?: number | null;
  created_at: string;
  updated_at: string;
}

/** Phase 1B — explicit tool allocation per supervisor agent row. */
export interface AgentToolRow {
  agent_id: string;
  tool_name: string;
  /** 'default' | 'required' | 'optional' — operator hint, currently advisory. */
  allocation: string;
}

/**
 * Phase 1B — resolved supervisor agent + its tool allocations, ready for chat
 * runtime consumption. The runtime never queries `agents`/`agent_tools`
 * directly — it always goes through `resolveSupervisorAgent`.
 */
export interface ResolvedSupervisorAgent {
  agent: SupervisorAgentRow;
  tools: AgentToolRow[];
}

export interface IdempotencyRecordRow {
  id: string;
  key: string;
  result_json: string;
  expires_at: string;
  created_at: string;
}

export interface OAuthFlowStateRow {
  id: string;
  state_key: string;
  user_id: string | null;
  provider: string;
  expires_at: string;
  created_at: string;
}

/**
 * Global / per-tenant agent strategy settings (agent_strategy_settings table).
 *
 * A single 'global' row is seeded by m40 and updated by subsequent migrations
 * (m63, m74). Tenant-scoped rows may also exist (scope='tenant', tenant_id set).
 * Chat-level settings in chat_settings take precedence over these defaults.
 *
 * Phase 7 (m74) adds:
 *   hitl_threshold, max_agent_hops, tool_confirmation_level, memory_policy
 * and flips the global defaults for a2a_enabled, supervisor_parallel_delegation,
 * and reflect_enabled from 0 → 1.
 */
export interface AgentStrategySettingsRow {
  id: string;
  scope: string;                         // 'global' | 'tenant'
  tenant_id: string | null;

  // W1 — Reflection
  reflect_enabled: number;
  reflect_max_revisions: number;
  reflect_criteria: string | null;

  // W2 — Verify/regenerate
  verify_enabled: number;
  verify_min_score: number;
  verify_max_attempts: number;

  // W3 — Supervisor
  supervisor_replan_on_failure: number;
  supervisor_parallel_delegation: number;

  // W5 — Ensemble
  ensemble_resolver: string | null;

  // A2A
  a2a_enabled: number;

  // P2 — Parallel tool execution + context management + tool retry (m63)
  parallel_tool_calls: number;
  context_strategy: string | null;
  context_max_tokens: number | null;
  context_window_size: number;
  tool_retry_max_attempts: number;
  tool_retry_backoff_ms: number;
  tool_retry_max_backoff_ms: number;

  // Phase 7 (m74) — 2026 safety + agentic governance
  /** Risk score threshold [0,1] at which HITL approval is required. */
  hitl_threshold: number;
  /** Maximum A2A delegation chain depth before the run is forcibly terminated. */
  max_agent_hops: number;
  /** 'none' | 'medium' | 'high-risk-only' — tool-level confirmation gate. */
  tool_confirmation_level: string;
  /** 'none' | 'session' | 'persistent' — controls cross-turn memory persistence. */
  memory_policy: string;

  updated_at: string;
}
