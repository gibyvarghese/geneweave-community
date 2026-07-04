/** Guardrails, routing policies, model pricing, and anyWeave task-aware routing row types. */

export interface GuardrailRevisionRow {
  id: string;
  guardrail_id: string;
  version: number;
  snapshot: string;      // JSON: full Guardrail object after the change
  before: string | null; // JSON: Guardrail state before the change (null on create)
  actor: string;
  reason: string;
  created_at: string;
}

export interface GuardrailRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  stage: string;
  config: string | null;                  // JSON object
  priority: number;
  enabled: number;
  trigger_conditions?: string | null;     // JSON ConditionNode — null/absent = always run
  trigger_description?: string | null;    // human-readable summary of the condition
  /** Phase 4: model ID used as LLM judge for this guardrail (e.g. claude-haiku-4-5-20251001). */
  judge_model?: string | null;
  /** Phase 4: regulatory/compliance framework this guardrail enforces (e.g. EU_AI_ACT_ART_5). */
  compliance_framework?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingPolicyRow {
  id: string;
  name: string;
  description: string | null;
  strategy: string;
  constraints: string | null;     // JSON object
  weights: string | null;         // JSON object
  fallback_model: string | null;
  fallback_provider: string | null;
  /** Phase 1 anyWeave routing — JSON [{modelId, provider, priority}]. */
  fallback_chain?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelPricingRow {
  id: string;
  model_id: string;
  provider: string;
  display_name: string | null;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  quality_score: number;
  source: string;                 // 'manual' | 'sync' | 'seed'
  last_synced_at: string | null;
  enabled: number;
  /** Phase 1 anyWeave routing — 'text' | 'image' | 'audio' | 'video' | 'embedding' | 'multimodal'. */
  output_modality?: string;
  // Phase 2 — provider-native prompt caching policy (per model).
  prompt_cache_enabled?: number;     // 1 = request caching of the stable prefix
  prompt_cache_min_tokens?: number;  // min stable-prefix size to cache (≈1024)
  prompt_cache_ttl?: string;         // '5m' | '1h'
  created_at: string;
  updated_at: string;
}

// ─── anyWeave Task-Aware Routing — Phase 1 row types ──────────
// Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md.
// All UUID PKs (TEXT). String JSON columns are decoded by callers.

export interface TaskTypeDefinitionRow {
  id: string;
  task_key: string;
  display_name: string;
  category: string;
  description: string;
  /** 'text' | 'code' | 'image' | 'audio' | 'video' | 'embedding' | 'multimodal'. */
  output_modality: string;
  /** 'cost' | 'speed' | 'quality' | 'capability' | 'balanced'. */
  default_strategy: string;
  /** JSON {cost,speed,quality,capability} summing to 1. */
  default_weights: string;
  /** JSON {keywords?: string[], requiresVision?: boolean, ...}. */
  inference_hints: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelCapabilityScoreRow {
  id: string;
  /** NULL = global default; otherwise tenant-specific override. */
  tenant_id: string | null;
  model_id: string;
  provider: string;
  task_key: string;
  /** 0–100 quality score for this (model, task) pair. */
  quality_score: number;
  supports_tools: number;
  supports_streaming: number;
  supports_thinking: number;
  supports_json_mode: number;
  supports_vision: number;
  max_output_tokens: number | null;
  benchmark_source: string | null;
  raw_benchmark_score: number | null;
  is_active: number;
  last_evaluated_at: string | null;
  /** Phase 5 — separate production telemetry signal (0–100). Null until first signal. */
  production_signal_score: number | null;
  /** Phase 5 — number of signals contributing to production_signal_score. */
  signal_sample_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskTypeTenantOverrideRow {
  id: string;
  tenant_id: string;
  task_key: string;
  /** JSON {cost,speed,quality,capability}. */
  weights: string | null;
  preferred_model_id: string | null;
  preferred_provider: string | null;
  preferred_boost_pct: number;
  cost_ceiling_per_call: number | null;
  optimisation_strategy: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderToolAdapterRow {
  id: string;
  provider: string;
  display_name: string;
  /** Module path (e.g. '@weaveintel/tools/schema/anthropic'). */
  adapter_module: string;
  /** 'anthropic_xml' | 'openai_json' | 'google_function' | 'mistral_function' | 'custom'. */
  tool_format: string;
  /** 'tool_use_block' | 'function_call' | 'tool_calls_array'. */
  tool_call_response_format: string;
  /** 'tool_result_block' | 'tool_message' | 'function_response'. */
  tool_result_format: string;
  /** 'system_message' | 'first_user_message' | 'separate_field'. */
  system_prompt_location: string;
  name_validation_regex: string;
  max_tool_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RoutingDecisionTraceRow {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  workflow_step_id: string | null;
  task_key: string | null;
  /** 'agent_default' | 'inference' | 'explicit' | 'workflow_step'. */
  inference_source: string | null;
  selected_model_id: string;
  selected_provider: string;
  selected_capability_score: number | null;
  /** JSON {cost,speed,quality,capability}. */
  weights_used: string;
  /** JSON [{modelId, provider, score, breakdown:{...}}]. */
  candidate_breakdown: string;
  tool_translation_applied: number;
  source_provider: string | null;
  estimated_cost_usd: number | null;
  decided_at: string;
}

/** Phase 5 — append-only signal log feeding capability score recompute. */
export interface RoutingCapabilitySignalRow {
  id: string;
  tenant_id: string | null;
  model_id: string;
  provider: string;
  task_key: string;
  /** 'eval' | 'chat' | 'cache' | 'production'. */
  source: string;
  /** Free-form per source (e.g. 'thumbs_up', 'json_compliance', 'rouge'). */
  signal_type: string;
  /** Normalised 0–100 contribution to quality_score. */
  value: number;
  /** Multiplier applied to the rolling-avg recompute (default 1.0). */
  weight: number;
  evidence_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  /** JSON object for source-specific context. */
  metadata: string | null;
  created_at: string;
}

/** Phase 5 — chat UI feedback (👍/👎/regenerate/copy) per message. */
export interface MessageFeedbackRow {
  id: string;
  message_id: string;
  chat_id: string | null;
  user_id: string | null;
  /** 'thumbs_up' | 'thumbs_down' | 'regenerate' | 'copy'. */
  signal: string;
  comment: string | null;
  /**
   * m137 — for a thumbs-down, the small fixed taxonomy of WHY (JSON array of reason keys, see
   * @weaveintel/collab FEEDBACK_CATEGORIES). Null for up-votes / older rows.
   */
  categories: string | null;
  /** m137 — workspace the feedback belongs to, so it can be summarised per tenant. */
  tenant_id: string | null;
  /** Snapshot of resolved (model, provider, task_key) at submit time. */
  model_id: string | null;
  provider: string | null;
  task_key: string | null;
  created_at: string;
}

/** Phase 5 — alerts emitted by the regression detection job. */
export interface RoutingSurfaceItemRow {
  id: string;
  /** 'quality_regression' | 'auto_disabled' | 'low_signal_volume'. */
  kind: string;
  /** 'info' | 'warning' | 'critical'. */
  severity: string;
  model_id: string;
  provider: string;
  task_key: string;
  tenant_id: string | null;
  message: string;
  metric_7d: number | null;
  metric_30d: number | null;
  drop_pct: number | null;
  sample_count_7d: number | null;
  sample_count_30d: number | null;
  auto_disabled: number;
  /** 'open' | 'acknowledged' | 'resolved'. */
  status: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Phase 6 — A/B routing experiment definitions. */
export interface RoutingExperimentRow {
  id: string;
  name: string;
  description: string | null;
  /** null = applies to all tenants. */
  tenant_id: string | null;
  /** null = applies to all task keys. */
  task_key: string | null;
  baseline_provider: string;
  baseline_model_id: string;
  candidate_provider: string;
  candidate_model_id: string;
  /** 0–100. Percentage of matching traffic routed to candidate. */
  traffic_pct: number;
  /** 'active' | 'paused' | 'completed'. */
  status: string;
  /** JSON object — free-form experiment metadata. */
  metadata: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}
