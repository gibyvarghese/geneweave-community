/** Core user, session, chat, metrics, and temporal row types. */

export interface UserRow {
  id: string;
  email: string;
  name: string;
  persona: string;
  tenant_id: string | null;
  password_hash: string;
  created_at: string;
  /** 1 = verified, 0 = pending verification. Existing rows grandfathered to 1 by m44. */
  email_verified?: number;
  email_verified_at?: string | null;
  /**
   * Phase 8 blind index — `HMAC-SHA-256(BIK, "users|email|<email>")` truncated
   * to 24 hex chars. Tenant-scoped, populated only when the resolved tenant
   * has `blind_index_enabled=true`. Lookup path: `WHERE email_bidx = ?`.
   */
  email_bidx?: string | null;
  /** 4.17: 1 = TOTP MFA enrolled and confirmed; 0 = not enrolled. */
  mfa_enabled?: number;
  /** 4.17: Vault-encrypted (or plaintext) base32 TOTP secret. NULL = not yet set up. */
  mfa_totp_secret?: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
  created_at: string;
  /** 4.17: ISO timestamp of the most recent step-up MFA challenge. NULL = not yet verified. */
  mfa_verified_at?: string | null;
}

export interface OAuthLinkedAccountRow {
  id: string;
  user_id: string;
  provider: string;              // google | github | microsoft | apple | facebook
  provider_user_id: string;      // ID from OAuth provider
  email: string;
  name: string;
  picture_url: string | null;
  linked_at: string;
  last_used_at: string | null;
}

export interface ChatRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  provider: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

/**
 * Denormalised conversation summary for the user-scoped conversation list
 * (SP2). Joins a chat with its derived snippet (most-recent message content)
 * and its chat-settings mode. Used by listUserConversations / getUserConversation.
 */
export interface ConversationRow {
  id: string;
  title: string;
  /** Most-recent message content, truncated by the route layer. Null when empty. */
  snippet: string | null;
  /** chat_settings.mode, coalesced to 'agent' when no settings row exists. */
  mode: string;
  model: string;
  provider: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  metadata: string | null;
  tokens_used: number;
  cost: number;
  latency_ms: number;
  created_at: string;
}

export interface MetricRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  type: string;
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  latency_ms: number;
  metadata: string | null;
  created_at: string;
}

export interface EvalRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  eval_name: string;
  score: number;
  passed: number;
  failed: number;
  total: number;
  details: string | null;
  created_at: string;
}

export interface UserPreferencesRow {
  user_id: string;
  default_mode: string;
  theme: string;
  show_process_card: number;
  updated_at: string;
  // m119 — per-user preferred language for sourced images.
  notes_image_language?: string;
  // m136 — Account settings surface (profile + formatting preferences). All nullable/defaulted.
  display_name?: string | null;
  pronouns?: string | null;
  role_title?: string | null;
  working_hours?: string | null;
  about?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
  language?: string;
  timezone?: string | null;
  date_format?: string;
  week_start?: string;
  ui_variant?: string;
}

/** m136 — one row per (user, notification event); which channels are on. */
export interface UserNotificationPrefRow {
  user_id: string;
  event_key: string;
  in_app: number;
  email: number;
  push: number;
  updated_at: string;
}

export interface ChatSettingsRow {
  chat_id: string;
  mode: string;
  system_prompt: string | null;
  timezone: string | null;
  enabled_tools: string | null;
  redaction_enabled: number;
  redaction_patterns: string | null;
  workers: string | null;
  updated_at: string;
  // W1 — Reflection (m40)
  reflect_enabled: number;
  reflect_max_revisions: number;
  reflect_criteria: string | null;
  // W2 — Verify/regenerate (m40)
  verify_enabled: number;
  verify_min_score: number;
  verify_max_attempts: number;
  // W3 — Supervisor (m40)
  supervisor_replan_on_failure: number;
  supervisor_parallel_delegation: number;
  // W5 — Ensemble (m40)
  ensemble_agents: string | null;
  ensemble_resolver: string | null;
  // Reasoning request (m92)
  reasoning_enabled: number;
  reasoning_effort: string | null;
  reasoning_budget_tokens: number;
  // P2-1 — Parallel tool execution (m63)
  parallel_tool_calls: number;
  // P2-3 — Context window management (m63)
  context_strategy: string | null;
  context_max_tokens: number | null;
  context_window_size: number;
  // P2-4 — Tool retry (m63)
  tool_retry_max_attempts: number;
  tool_retry_backoff_ms: number;
  tool_retry_max_backoff_ms: number;
  // P3-1 — HITL interrupt (m64)
  hitl_enabled: number;
  hitl_require_all: number;
  hitl_timeout_ms: number;
  // P3-2 — Agent handoff (m64)
  handoffs_enabled: number;
  // P4-3 — Knowledge graph memory (m65)
  graph_enabled: number;
  graph_max_nodes: number;
  graph_persist_enabled: number;
  // P4-2 — Proactive memory context injection (m65)
  memory_context_enabled: number;
  memory_context_max_chars: number;
  // P5-1 — Agent checkpoint / resume (m66)
  checkpoint_enabled: number;
  checkpoint_interval_steps: number;
  // P5-2 — Dynamic worker registry (m66)
  dynamic_workers_enabled: number;
  max_dynamic_workers: number;
  // P6-1 — Multi-tier eval pipeline (m67)
  eval_pipeline_enabled: number;
  eval_pipeline_stages: string | null;
  eval_pipeline_fail_fast: number;
  // P6-3 — Cost governor (m67)
  cost_governor_enabled: number;
  cost_governor_policy: string | null;
  // P6-4 — Compliance-aware tool execution (m67)
  compliance_enabled: number;
  compliance_subject_id_field: string | null;
  compliance_enforce_consent: number;
  // P6-5 — Vision loop (m67)
  vision_loop_enabled: number;
}

export interface TraceRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  message_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: number;
  end_time: number | null;
  status: string | null;
  attributes: string | null;
  events: string | null;
  created_at: string;
}

export interface TemporalTimerRow {
  id: string;
  scope_id: string;
  label: string | null;
  duration_ms: number | null;
  state: string;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  stopped_at: string | null;
  elapsed_ms: number;
  updated_at: string;
}

export interface TemporalStopwatchRow {
  id: string;
  scope_id: string;
  label: string | null;
  state: string;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  stopped_at: string | null;
  elapsed_ms: number;
  laps_json: string;
  updated_at: string;
}

export interface TemporalReminderRow {
  id: string;
  scope_id: string;
  text: string;
  due_at: string;
  timezone: string;
  status: string;
  created_at: string;
  cancelled_at: string | null;
  updated_at: string;
}

export interface MetricsSummary {
  total_tokens: number;
  total_cost: number;
  avg_latency_ms: number;
  total_messages: number;
  total_chats: number;
  by_model: Array<{ model: string; provider: string; tokens: number; cost: number; count: number }>;
  by_day: Array<{ date: string; tokens: number; cost: number; count: number }>;
}
