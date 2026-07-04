/** DB-driven live-agents mesh blueprint and runtime row types. */

/**
 * Projection of a single inter-agent message stored in the live-agents
 * StateStore (`la_entities` where `entity_type='message'`). Surfaced to the
 * Run record view so operators can inspect the dialogue between agents.
 */
export interface LiveMeshMessageView {
  id: string;
  meshId: string | null;
  fromType: string | null;
  fromId: string | null;
  toType: string | null;
  toId: string | null;
  topic: string | null;
  kind: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  processedAt: string | null;
}

// Mesh blueprint stored in `live_mesh_definitions`; per-role agent persona
// in `live_agent_definitions`; pipeline graph in `live_mesh_delegation_edges`.
// Runtime boot loads a snapshot at provision time; per-competition playbook
// overlays still apply on top via the `kaggle_playbook` skill resolver.
export interface LiveMeshDefinitionRow {
  id: string;                                  // UUIDv7
  mesh_key: string;                            // unique slug (e.g. 'kaggle')
  name: string;
  charter_prose: string;
  dual_control_required_for: string;           // JSON array of tool keys
  enabled: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveAgentDefinitionRow {
  id: string;                                  // UUIDv7
  mesh_def_id: string;
  role_key: string;                            // e.g. 'discoverer'
  name: string;                                // e.g. 'Kaggle Discoverer'
  role_label: string;                          // e.g. 'Competition Discoverer'
  persona: string;
  objectives: string;
  success_indicators: string;
  ordering: number;
  enabled: number;
  // ─── Phase 3.5 — DB-driven model routing defaults ────────────
  // JSON capability spec (e.g. {task:'reasoning', toolUse:true}). Consumed by
  // resolveLiveAgentModel() in @weaveintel/live-agents. Null = inherit
  // platform default.
  model_capability_json?: string | null;
  // Optional override key into the routing policy registry.
  model_routing_policy_key?: string | null;
  // Escape hatch: pin a specific model id for reproducibility runs.
  model_pinned_id?: string | null;
  // ─── Phase 5 — Generic provisioner defaults ─────────────────
  // Used by `provisionMesh()` to seed `live_agent_handler_bindings`,
  // `live_agent_tool_bindings`, and the runtime `attention_policy_key`
  // when an operator instantiates this blueprint.
  default_handler_kind?: string | null;        // e.g. 'agentic.react'
  default_handler_config_json?: string | null; // JSON config for that kind
  default_tool_catalog_keys?: string | null;   // JSON array of tool_key strings
  default_attention_policy_key?: string | null;// e.g. 'heuristic.inbox-first'
  created_at: string;
  updated_at: string;
}

export interface LiveMeshDelegationEdgeRow {
  id: string;                                  // UUIDv7
  mesh_def_id: string;
  from_role_key: string;
  to_role_key: string;
  relationship: string;                        // 'DIRECTS' | 'COLLABORATES_WITH' | ...
  prose: string;
  ordering: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ─── DB-Driven Live-Agents Runtime (M22, Phase 1) ────────────
// Provisioned runtime entities (vs blueprint definitions above). Splits the
// "what an operator designed" from "what is actually live for a tenant" so
// tenants can spin up N runtime meshes from one blueprint.

/** Catalog of runtime handler kinds (e.g. agentic.react). Plugins implement these. */
export interface LiveHandlerKindRow {
  id: string;
  kind: string;                                // unique key, e.g. 'agentic.react'
  description: string;
  config_schema_json: string;                  // JSON schema for handler config
  source: string;                              // 'builtin' | 'plugin'
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** DB-managed attention policies (when should an agent take a tick). */
export interface LiveAttentionPolicyRow {
  id: string;
  key: string;                                 // e.g. 'heuristic.inbox-first'
  kind: string;                                // 'heuristic' | 'cron' | 'model'
  description: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A provisioned runtime mesh (one per tenant per blueprint). */
export interface LiveMeshRow {
  id: string;
  tenant_id: string | null;
  mesh_def_id: string;
  name: string;
  status: string;                              // 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  domain: string | null;
  dual_control_required_for: string;           // JSON array of tool keys
  owner_human_id: string | null;
  mcp_server_ref: string | null;
  account_id: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

/** A provisioned agent inside a runtime mesh. */
export interface LiveAgentRow {
  id: string;
  mesh_id: string;
  agent_def_id: string | null;
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  attention_policy_key: string | null;
  contract_version_id: string | null;
  status: string;                              // 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  ordering: number;
  archived_at: string | null;
  // ─── Phase 3.5 — model routing (mirror of definition defaults) ──
  // Resolution order at runtime: pinned id → capability spec via routing
  // policy → inherited from agent_def → platform default.
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
  /**
   * Phase 2 (DB-driven capability plan) — declarative `prepare()` recipe
   * JSON. When set, the runtime synthesises the agent's `prepare()`
   * function from this recipe. See
   * `packages/live-agents-runtime/src/db-prepare-resolver.ts`.
   */
  prepare_config_json?: string | null;
  created_at: string;
  updated_at: string;
}

/** Which handler kind dispatches this agent's ticks plus opaque config. */
export interface LiveAgentHandlerBindingRow {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** M2M: agent → tool_catalog row OR external MCP endpoint. */
export interface LiveAgentToolBindingRow {
  id: string;
  agent_id: string;
  tool_catalog_id: string | null;
  mcp_server_url: string | null;
  capability_keys: string;                     // JSON array
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A "campaign" inside a mesh — generic replacement for kgl_competition_runs. */
export interface LiveRunRow {
  id: string;
  mesh_id: string;
  tenant_id: string | null;
  run_key: string;
  label: string | null;
  status: string;                              // 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABANDONED'
  stop_requested: number;                      // 1 = stop signal set; agent loop should halt
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Lightweight run started via the REST API — no mesh FK requirement. */
export interface ApiLiveRunRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  agent_id: string | null;
  status: string;              // 'running' | 'stopped' | 'completed' | 'failed'
  stop_requested: number;      // 1 = stop signal persisted to DB; survives restarts
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-agent progress ledger inside a run. Generic replacement for kgl_run_step. */
export interface LiveRunStepRow {
  id: string;
  run_id: string;
  mesh_id: string;
  agent_id: string | null;
  role_key: string;
  status: string;                              // 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Append-only event log. Generic replacement for kgl_run_event. */
export interface LiveRunEventRow {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;                                // e.g. 'tool_call', 'handoff', 'error'
  agent_id: string | null;
  tool_key: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
}
