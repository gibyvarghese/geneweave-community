/** Admin policy, governance, connector, and configuration row types. */

export interface HumanTaskPolicyRow {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  task_type: string;
  default_priority: string;
  sla_hours: number | null;
  auto_escalate_after_hours: number | null;
  assignment_strategy: string;
  assign_to: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TaskContractRow {
  id: string;
  name: string;
  description: string | null;
  input_schema: string | null;           // JSON object
  output_schema: string | null;          // JSON object
  acceptance_criteria: string;           // JSON array
  max_attempts: number | null;
  timeout_ms: number | null;
  evidence_required: string | null;      // JSON array
  min_confidence: number | null;
  require_human_review: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CachePolicyRow {
  id: string;
  name: string;
  description: string | null;
  scope: string;               // 'global' | 'tenant' | 'user' | 'session' | 'agent'
  ttl_ms: number;
  max_entries: number;
  max_bytes: number;               // approximate L1 byte budget; 0 = off
  bypass_patterns: string | null;  // JSON array — matched against the prompt
  output_bypass_patterns: string | null;  // JSON array — matched against the response
  invalidate_on: string | null;    // JSON array of event types
  key_hashing: string;             // 'none' | 'sha256'
  tenant_isolation: number;        // 1 = fold tenant id into the cache key
  cache_temperature_gate: number;  // cache only when effective temperature ≤ this
  swr_ms?: number;                 // Phase 7: stale-while-revalidate window (0 = off)
  negative_ttl_ms?: number;        // Phase 7: negative-cache TTL for misses/errors (0 = off)
  eviction_policy?: string;        // Phase 7: 'lru'|'lfu'|'fifo'|'tinylfu'|'gdsf'
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CacheMetricsRow {
  window_start: string;            // hourly bucket 'YYYY-MM-DDTHH:00:00Z'
  response_hits: number;
  response_misses: number;
  prompt_cache_read_tokens: number;
  prompt_cache_write_tokens: number;
  cost_saved_usd: number;
  updated_at: string;
}

/** A partial increment applied to the current hourly cache_metrics window. */
export interface CacheMetricsDelta {
  responseHits?: number;
  responseMisses?: number;
  promptCacheReadTokens?: number;
  promptCacheWriteTokens?: number;
  costSavedUsd?: number;
}

/** Aggregate cache-metrics view returned to the admin dashboard. */
export interface CacheMetricsSummary {
  totals: {
    responseHits: number;
    responseMisses: number;
    hitRate: number;
    promptCacheReadTokens: number;
    promptCacheWriteTokens: number;
    costSavedUsd: number;
  };
  windows: CacheMetricsRow[];
}

export interface CacheInvalidationRuleRow {
  id: string;
  name: string;
  trigger: string;          // event type ('model_change', 'prompt_update', ...)
  pattern: string | null;   // optional payload regex
  config: string | null;    // JSON: { clearAll, prefix, prefixFromPayload, scope, query, ... }
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ToolCachePolicyRow {
  id: string;
  tool_name: string;     // schema name of the tool this policy governs
  cacheable: number;     // 1 = its result may be cached, 0 = never
  ttl_ms: number;        // time-to-live for a cached result
  enabled: number;       // 1 = policy active
  created_at: string;
  updated_at: string;
}

export interface SemanticCacheConfigRow {
  id: string;                      // always 'global'
  enabled: number;
  embedding_model: string;
  embedding_version: string;
  similarity_threshold: number;
  invalidation_radius: number;
  max_entries: number;
  ttl_ms: number;
  scope: string;                   // 'global' | 'tenant' | 'user' | 'session'
  bypass_patterns: string | null;  // JSON array of time-sensitive patterns
  verified_bounds: number;
  updated_at: string;
}

export interface RunStreamConfigRow {
  id: string;                      // always 'global'
  enabled: number;
  heartbeat_ms: number;            // SSE keepalive interval (server)
  max_reconnects: number;          // client auto-reconnect budget
  backoff_ms: string;              // JSON array of reconnect delays (ms)
  stall_timeout_ms: number;        // tear-down window for a silent stream
  throttle_ms: number;             // client UI-update throttle
  journal_retention_hours: number; // user_run_events pruning horizon
  journal_max_events: number;      // max persisted events per run
  resume_window_seconds: number;   // refresh-proof resume window
  updated_at: string;
}

export interface AgentPlanCacheConfigRow {
  id: string;                      // always 'global'
  enabled: number;
  similarity_threshold: number;    // a past plan must clear this to be reused
  min_steps: number;               // min executed steps before a plan is cached
  max_entries: number;
  ttl_ms: number;
  scope: string;                   // 'global' | 'tenant' | 'user' | 'session'
  embedding_model: string;
  updated_at: string;
}

export interface CacheSettingsRow {
  id: string;                      // always 'global'
  l2_enabled: number;             // 1 = use distributed L2 (Redis)
  l2_provider: string;            // 'none' | 'redis'
  l1_max_entries: number;
  l1_max_bytes: number;
  l1_ttl_ms: number;              // staleness cap for L1 copies of L2 entries
  key_namespace: string;          // Redis key prefix
  global_version_token: string;   // bump to invalidate every cache key
  stampede_protection: number;    // Phase 7: coalesce concurrent identical requests
  metrics_enabled: number;        // Phase 3 observability rollup toggle
  l1_eviction_policy?: string;    // Phase 7: 'lru'|'lfu'|'fifo'|'tinylfu'|'gdsf'
  l1_negative_ttl_ms?: number;    // Phase 7: global negative-cache TTL fallback
  updated_at: string;
}

export interface IdentityRuleRow {
  id: string;
  name: string;
  description: string | null;
  resource: string;
  action: string;
  roles: string | null;           // JSON array
  scopes: string | null;          // JSON array
  result: string;                 // 'allow' | 'deny' | 'challenge'
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryGovernanceRow {
  id: string;
  name: string;
  description: string | null;
  memory_types: string | null;    // JSON array
  tenant_id: string | null;
  block_patterns: string | null;  // JSON array
  redact_patterns: string | null; // JSON array
  max_age: string | null;         // ISO 8601 duration
  max_entries: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryExtractionRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;              // 'self_disclosure' | 'entity_extraction'
  entity_type: string | null;     // used for entity_extraction rules
  pattern: string;
  flags: string | null;           // regex flags e.g. 'i', 'gi'
  facts_template: string | null;  // JSON object for additional facts
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SearchProviderRow {
  id: string;
  name: string;
  description: string | null;
  provider_type: string;          // e.g. 'duckduckgo','brave','google','tavily','bing','searxng','jina','exa','serper'
  api_key: string | null;
  base_url: string | null;
  priority: number;
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface HttpEndpointRow {
  id: string;
  name: string;
  description: string | null;
  url: string;
  method: string;                 // GET, POST, PUT, DELETE, PATCH
  auth_type: string | null;       // api_key, bearer, basic, oauth2
  auth_config: string | null;     // JSON object
  headers: string | null;         // JSON object
  body_template: string | null;
  response_transform: string | null;
  retry_count: number;
  rate_limit_rpm: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SocialAccountRow {
  id: string;
  name: string;
  description: string | null;
  platform: string;               // facebook, instagram, slack, discord
  api_key: string | null;
  api_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  oauth_state: string | null;
  status: string;                 // disconnected, connected, error
  base_url: string | null;
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EnterpriseConnectorRow {
  id: string;
  name: string;
  description: string | null;
  connector_type: string;         // jira, servicenow, canva, confluence, salesforce
  base_url: string | null;
  auth_type: string | null;       // bearer, oauth2, api_key, basic, service_account
  auth_config: string | null;     // JSON object
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  oauth_state: string | null;
  status: string;                 // disconnected, connected, error
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReplayScenarioRow {
  id: string;
  name: string;
  description: string | null;
  golden_prompt: string;
  golden_response: string;
  model: string | null;
  provider: string | null;
  tags: string | null;           // JSON array
  acceptance_criteria: string | null; // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;          // cron, webhook, queue, change, event
  expression: string | null;     // cron expression or filter pattern
  config: string | null;         // JSON object
  target_workflow: string | null;
  status: string;                // active, paused, disabled
  last_fired_at: string | null;
  fire_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TenantConfigRow {
  id: string;
  name: string;
  description: string | null;
  tenant_id: string;
  scope: string;                 // global, organization, tenant, user
  allowed_models: string | null; // JSON array
  denied_models: string | null;  // JSON array
  allowed_tools: string | null;  // JSON array
  max_tokens_daily: number | null;
  max_cost_daily: number | null;
  max_tokens_monthly: number | null;
  max_cost_monthly: number | null;
  features: string | null;       // JSON array
  config_overrides: string | null; // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SandboxPolicyRow {
  id: string;
  name: string;
  description: string | null;
  max_cpu_ms: number | null;
  max_memory_mb: number | null;
  max_duration_ms: number;
  max_output_bytes: number | null;
  allowed_modules: string | null;    // JSON array
  denied_modules: string | null;     // JSON array
  network_access: number;
  filesystem_access: string;         // 'none' | 'read-only' | 'read-write'
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ExtractionPipelineRow {
  id: string;
  name: string;
  description: string | null;
  stages: string;                    // JSON array of stage configs
  input_mime_types: string | null;   // JSON array
  max_input_size_bytes: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactPolicyRow {
  id: string;
  name: string;
  description: string | null;
  max_size_bytes: number | null;
  allowed_types: string | null;      // JSON array of ArtifactType
  retention_days: number | null;
  require_versioning: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReliabilityPolicyRow {
  id: string;
  name: string;
  description: string | null;
  policy_type: string;               // 'retry' | 'idempotency' | 'concurrency' | 'backpressure'
  max_retries: number | null;
  initial_delay_ms: number | null;
  max_delay_ms: number | null;
  backoff_multiplier: number | null;
  max_concurrent: number | null;
  queue_size: number | null;
  strategy: string | null;           // 'reject' | 'queue' | 'shed-oldest'
  ttl_ms: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationSessionRow {
  id: string;
  name: string;
  description: string | null;
  session_type: string;              // 'pair' | 'team' | 'broadcast'
  max_participants: number;
  presence_ttl_ms: number;
  auto_close_idle_ms: number | null;
  handoff_enabled: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ComplianceRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;                 // 'retention' | 'deletion' | 'legal-hold' | 'residency' | 'consent'
  target_resource: string;
  retention_days: number | null;
  region: string | null;
  consent_purpose: string | null;
  action: string;                    // 'delete' | 'archive' | 'anonymize' | 'block' | 'notify'
  config: string | null;             // JSON
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface GraphConfigRow {
  id: string;
  name: string;
  description: string | null;
  graph_type: string;                // 'entity' | 'timeline' | 'knowledge'
  max_depth: number;
  entity_types: string | null;       // JSON array
  relationship_types: string | null; // JSON array
  auto_link: number;
  scoring_weights: string | null;    // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PluginConfigRow {
  id: string;
  name: string;
  description: string | null;
  plugin_type: string;               // 'official' | 'verified' | 'community' | 'private'
  package_name: string;
  version: string;
  capabilities: string | null;       // JSON array
  trust_level: string;               // 'official' | 'verified' | 'community' | 'private'
  auto_update: number;
  config: string | null;             // JSON
  enabled: number;
  created_at: string;
  updated_at: string;
}
