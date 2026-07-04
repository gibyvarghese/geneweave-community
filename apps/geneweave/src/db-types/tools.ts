/** Tool catalog, policies, audit, health, credentials, MCP gateway, and skill row types. */

export interface ToolCatalogRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  risk_level: string;
  requires_approval: number;
  max_execution_ms: number | null;
  rate_limit_per_min: number | null;
  enabled: number;
  tool_key: string | null;
  version: string;
  side_effects: number;
  tags: string | null;           // JSON string[]
  source: string;                // 'builtin' | 'mcp' | 'a2a' | 'custom'
  credential_id: string | null;
  config?: string | null;        // JSON: e.g. { endpoint } for MCP, { agentUrl } for A2A
  allocation_class?: string | null; // utility | web | social | search | cse | http | enterprise | code | data | communication
  /**
   * Phase D — JSON-encoded array of runtime capability ids the tool
   * needs (e.g. `runtime.net.egress`, `runtime.secrets`). Populated by
   * `syncToolCatalog` from `schema.requires`. Null for tools with no
   * declared requirements.
   */
  requires?: string | null;
  /** Scope this tool belongs to — matches agent_scopes.id. Added in m76. */
  agentic_scope?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolPolicyRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  applies_to: string | null;              // JSON string[]
  applies_to_risk_levels: string | null;  // JSON string[]
  approval_required: number;
  allowed_risk_levels: string | null;     // JSON string[]
  max_execution_ms: number | null;
  rate_limit_per_minute: number | null;
  max_concurrent: number | null;
  require_dry_run: number;
  log_input_output: number;
  persona_scope: string | null;           // JSON string[]
  active_hours_utc: string | null;        // JSON { start: "HH:MM", end: "HH:MM" }
  expires_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ToolRateLimitBucketRow {
  id: string;
  tool_name: string;
  scope_key: string;
  window_start: string;
  count: number;
}

// ─── Phase 3: Audit + Health ──────────────────────────────────

export interface ToolAuditEventRow {
  id: string;
  tool_name: string;
  chat_id: string | null;
  user_id: string | null;
  agent_persona: string | null;
  skill_key: string | null;
  policy_id: string | null;
  outcome: string;             // ToolAuditOutcome
  violation_reason: string | null;
  duration_ms: number | null;
  input_preview: string | null;
  output_preview: string | null;
  error_message: string | null;
  metadata: string | null;     // JSON
  created_at: string;
}

export interface ToolHealthSnapshotRow {
  id: string;
  tool_name: string;
  snapshot_at: string;
  invocation_count: number;
  success_count: number;
  error_count: number;
  denied_count: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  error_rate: number;
  availability: number;
  created_at: string;
}

/**
 * Resilience Phase 4: Endpoint Health row.
 *
 * One row per logical resilience endpoint id (e.g. `'openai:rest'`,
 * `'anthropic:rest'`, `'google:rest'`, `'tools-http:<config.name>'`).
 * Updated by the in-process `DbResilienceObserver` which subscribes to
 * `getDefaultSignalBus()` from `@weaveintel/resilience` and batches
 * upserts every ~1s.
 */
export interface EndpointHealthRow {
  endpoint: string;
  /** Last known circuit state: 'closed' | 'open' | 'half_open' | null. */
  circuit_state: string | null;
  consecutive_failures: number;
  last_signal_at: string | null;
  last_429_at: string | null;
  last_retry_after_ms: number | null;
  last_circuit_opened_at: string | null;
  last_circuit_closed_at: string | null;
  total_success: number;
  total_failed: number;
  total_rate_limited: number;
  total_retries: number;
  total_shed: number;
  total_circuit_opens: number;
  /** Exponentially-smoothed mean of success-call durationMs (alpha=0.2). */
  avg_latency_ms: number | null;
  updated_at: string;
}

/** Aggregated, batched delta written by `DbResilienceObserver`. All counter
 *  fields are *increments*, all `last_*` fields are *replacements*. Any
 *  field left undefined is left untouched on the existing row. */
export interface EndpointHealthDelta {
  endpoint: string;
  /** Replace circuit_state if defined. */
  circuit_state?: string | null;
  /** Replace consecutive_failures if defined (the resilience layer is the source of truth). */
  consecutive_failures?: number;
  /** Replace if defined. */
  last_signal_at?: string;
  last_429_at?: string;
  last_retry_after_ms?: number;
  last_circuit_opened_at?: string;
  last_circuit_closed_at?: string;
  /** Increments. Default 0. */
  inc_success?: number;
  inc_failed?: number;
  inc_rate_limited?: number;
  inc_retries?: number;
  inc_shed?: number;
  inc_circuit_opens?: number;
  /** Latency samples to fold into the EMA (alpha=0.2). */
  latency_samples_ms?: number[];
}

export interface ToolHealthSummary {
  tool_name: string;
  total_invocations: number;
  success_count: number;
  error_count: number;
  denied_count: number;
  avg_duration_ms: number | null;
  error_rate: number;
  availability: number;
  last_invoked_at: string | null;
}

/** Phase 4: Credential binding for tools that require external API keys.
 *  The actual secret lives in the env var named by `env_var_name`; no
 *  plaintext secrets are stored in this row. */
export interface ToolCredentialRow {
  id: string;
  name: string;
  description: string | null;
  /** Type of credential: api_key | oauth_token | basic_auth | jwt | custom */
  credential_type: string;
  /** JSON array of tool_key strings that use this credential */
  tool_names: string | null;
  /** Name of the environment variable that holds the secret value */
  env_var_name: string | null;
  /** JSON blob: { headerName?: string; prefix?: string; [key: string]: unknown } */
  config: string | null;
  /** ISO datetime when the credential is due for rotation */
  rotation_due_at: string | null;
  /** Validation status: valid | invalid | unknown | expired */
  validation_status: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Phase 5: Per-client MCP gateway bearer token. The plaintext token is
 *  never persisted — only its SHA-256 digest in `token_hash`. The client
 *  presents the raw token; we hash + look up by hash in constant time. */
export interface MCPGatewayClientRow {
  id: string;
  /** Operator-facing name (e.g. "claude-desktop-laptop", "ci-runner"). */
  name: string;
  description: string | null;
  /** SHA-256 hex digest of the bearer token. Never null; never plaintext. */
  token_hash: string;
  /** JSON array of allocation classes this client may reach.
   *  When null, the client inherits the gateway-wide exposed_classes set. */
  allowed_classes: string | null;
  /** Audit chat_id stamped on every tool_audit_events row from this client.
   *  When null, defaults to `mcp-gateway:<name>`. */
  audit_chat_id: string | null;
  /**
   * A-9: Tenant scope for rate limiting. When set, the rate-limit bucket is
   * keyed on `(tenant_id, id)` rather than `id` alone — a client's quota
   * cannot be consumed by another tenant's traffic even if IDs were somehow
   * reused, and per-tenant quota roll-ups become possible in the future.
   * NULL = "global" / single-tenant deployment (no tenant partitioning).
   * Optional for backwards compatibility — existing row objects without this
   * field are treated as NULL (global) by the rate limiter.
   */
  tenant_id?: string | null;
  enabled: number;
  last_used_at: string | null;
  /** ISO timestamp set when the operator revokes this client. NULL = active. */
  revoked_at: string | null;
  /** Phase 7: per-client request rate cap (requests per minute). NULL = no cap. */
  rate_limit_per_minute: number | null;
  /** Phase 9: ISO timestamp at which this token stops being honored.
   *  NULL = no expiry (token is valid until manually revoked or rotated). */
  expires_at: string | null;
  /** Phase 9: ISO timestamp of the last successful token rotation.
   *  NULL = never rotated since creation. */
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Phase 8: terminal outcome of a single MCP gateway request. */
export type MCPGatewayRequestOutcome =
  | 'ok'
  | 'rate_limited'
  | 'unauthorized'
  | 'disabled'
  | 'error'
  | 'expired';

/** Phase 8: Append-only log row capturing one MCP gateway request. */
export interface MCPGatewayRequestLogRow {
  id: string;
  /** Matched client id; null for unauthorized requests or single-tenant mode. */
  client_id: string | null;
  /** Snapshot of the client name at request time (helps when clients are deleted). */
  client_name: string | null;
  /** JSON-RPC method (e.g. 'tools/list', 'tools/call'). Null when unparseable. */
  method: string | null;
  /** Tool name when method='tools/call'; null otherwise. */
  tool_name: string | null;
  outcome: MCPGatewayRequestOutcome;
  status_code: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

/** Phase 8: aggregate counts per gateway client over a time window. */
export interface MCPGatewayActivitySummary {
  client_id: string | null;
  client_name: string | null;
  total: number;
  ok: number;
  rate_limited: number;
  unauthorized: number;
  errors: number;
  last_seen: string | null;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_patterns: string;      // JSON string[]
  instructions: string;
  tool_names: string | null;     // JSON string[]
  examples: string | null;       // JSON array
  tags: string | null;           // JSON string[]
  priority: number;
  version: string;
  /** Phase 6: tool policy key that overrides the global tool policy while this skill is active */
  tool_policy_key: string | null;
  /** Phase 1B: optional pin to a specific supervisor agent row in `agents`. */
  supervisor_agent_id?: string | null;
  /**
   * Optional JSON array of {key,label?,content,tags?} domain-scoped
   * sub-playbooks. When set, the skill prompt renderer scores each section
   * against the user query and includes only the most relevant ones,
   * instead of merging the whole playbook into the supervisor prompt.
   */
  domain_sections?: string | null;
  /**
   * Optional JSON object describing a machine-enforced execution contract
   * for this skill (e.g. minimum delegations, required output substrings).
   * Shape: { minDelegations?: number; requiredOutputSubstrings?: string[];
   * requiredOutputPatterns?: string[] }. When set, the chat runtime
   * validates the agent result against it and reports concrete deltas
   * back to the model on retry.
   */
  execution_contract?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Phase 6: Tool Approval Request — created by DbToolApprovalGate when a tool requires operator approval */
export interface ToolApprovalRequestRow {
  id: string;
  tool_name: string;
  chat_id: string;
  user_id: string | null;
  /** JSON snapshot of the tool input at the time of the request */
  input_json: string;
  policy_key: string | null;
  skill_key: string | null;
  /** pending | approved | denied | expired */
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface ToolRegistryRow {
  id: string;
  name: string;
  description: string | null;
  package_name: string;           // npm package or internal identifier
  version: string;
  category: string;
  risk_level: string;             // low, medium, high, critical
  tags: string | null;            // JSON array
  config: string | null;          // JSON object
  requires_approval: number;
  max_execution_ms: number | null;
  rate_limit_per_min: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ─── A2A Skills ───────────────────────────────────────────────────────────
// DB-backed A2A capability skills published on the Agent Card.
// Replaces the hardcoded A2A_SKILLS constant in routes/a2a.ts.

export interface A2ASkillRow {
  /** Kebab-case unique ID — used as skill id in Agent Cards and JWT scope claims. */
  id: string;
  /** Human-readable label shown in Agent Card and admin UI. */
  name: string;
  /** Model-facing capability description. */
  description: string;
  /** JSON string[] — discovery tags. */
  tags: string | null;
  /** JSON string[] — example prompts for A2A clients. */
  examples: string | null;
  /** JSON string[] — accepted MIME types (text/plain, audio/*, image/*, etc.). */
  input_modes: string | null;
  /** JSON string[] — produced MIME types. */
  output_modes: string | null;
  /** JSON string[] — OAuth2 scope tokens required, e.g. ['a2a:chat']. */
  security_scopes: string;
  /** Execution mode this skill maps to: 'agent' | 'supervisor' | 'ensemble'. */
  mode: string;
  /** RBAC permission required, e.g. 'agents:delegate'. null = any authenticated user. */
  required_permission: string | null;
  /** Display/listing order (ascending). */
  sort_order: number;
  /** 1 = published in Agent Card; 0 = hidden. */
  enabled: number;
  /**
   * JSON string[] — explicit tool list for the agent that handles this skill.
   * null = use getDefaultToolsByMode(mode) (recommended for most skills).
   * Set to a specific list to restrict or expand beyond the mode defaults.
   */
  agent_tools: string | null;
  /**
   * JSON WorkerDef[] — worker topology for supervisor/ensemble mode skills.
   * null = use the supervisor's default workers from DB.
   * Required for supervisor skills that need a code_executor or specialist worker.
   */
  agent_workers: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Cost Governor Phase 8: Tool Embeddings (Intent-RAG) ──────────────────
// Pre-computed embeddings for every tool's model-facing description.
// Used by the intent-rag strategy of the L3 toolSubset lever. UUID PK.
// `embedding` is JSON-encoded `number[]` — kept as TEXT for SQLite portability.
// `description_hash` is FNV-1a 64-bit hex (16 chars) used to detect when a
// tool description has changed since the cached embedding was computed.
export interface ToolEmbeddingRow {
  id: string;
  tool_key: string;
  model_id: string;
  dimension: number;
  embedding: string;
  description_hash: string;
  created_at: string;
  updated_at: string;
}
