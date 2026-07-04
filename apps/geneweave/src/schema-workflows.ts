/**
 * Workflow orchestration, human-in-the-loop tasks, cache/reliability/sandbox policies,
 * and trigger definitions.
 *
 * Relationships:
 *   workflow_runs — soft-references workflow_defs.id
 *   human_task_policies — standalone; tasks reference them externally
 *   task_contracts — referenced by worker_agents
 */
export const SCHEMA_WORKFLOWS_SQL = `
CREATE TABLE IF NOT EXISTS workflow_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  steps TEXT NOT NULL,
  entry_step_id TEXT NOT NULL,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  state TEXT NOT NULL DEFAULT '{}',
  input TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS human_task_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'approval',
  default_priority TEXT NOT NULL DEFAULT 'normal',
  sla_hours REAL,
  auto_escalate_after_hours REAL,
  assignment_strategy TEXT NOT NULL DEFAULT 'round-robin',
  assign_to TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  output_schema TEXT,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  max_attempts INTEGER,
  timeout_ms INTEGER,
  evidence_required TEXT,
  min_confidence REAL,
  require_human_review INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cache_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  ttl_ms INTEGER NOT NULL DEFAULT 300000,
  max_entries INTEGER NOT NULL DEFAULT 1000,
  max_bytes INTEGER NOT NULL DEFAULT 0,
  bypass_patterns TEXT,
  output_bypass_patterns TEXT,
  invalidate_on TEXT,
  key_hashing TEXT NOT NULL DEFAULT 'sha256',
  tenant_isolation INTEGER NOT NULL DEFAULT 1,
  cache_temperature_gate REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cache_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  l2_enabled INTEGER NOT NULL DEFAULT 0,
  l2_provider TEXT NOT NULL DEFAULT 'none',
  l1_max_entries INTEGER NOT NULL DEFAULT 5000,
  l1_max_bytes INTEGER NOT NULL DEFAULT 0,
  l1_ttl_ms INTEGER NOT NULL DEFAULT 30000,
  key_namespace TEXT NOT NULL DEFAULT 'weave:cache',
  global_version_token TEXT NOT NULL DEFAULT 'v1',
  stampede_protection INTEGER NOT NULL DEFAULT 0,
  metrics_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cache_metrics (
  window_start TEXT PRIMARY KEY,
  response_hits INTEGER NOT NULL DEFAULT 0,
  response_misses INTEGER NOT NULL DEFAULT 0,
  prompt_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_saved_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cache_invalidation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  pattern TEXT,
  config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS semantic_cache_config (
  id TEXT PRIMARY KEY DEFAULT 'global',
  enabled INTEGER NOT NULL DEFAULT 1,
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_version TEXT NOT NULL DEFAULT 'v1',
  similarity_threshold REAL NOT NULL DEFAULT 0.92,
  invalidation_radius REAL NOT NULL DEFAULT 0.95,
  max_entries INTEGER NOT NULL DEFAULT 1000,
  ttl_ms INTEGER NOT NULL DEFAULT 600000,
  scope TEXT NOT NULL DEFAULT 'user',
  bypass_patterns TEXT,
  verified_bounds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sandbox_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_cpu_ms INTEGER,
  max_memory_mb INTEGER,
  max_duration_ms INTEGER NOT NULL DEFAULT 30000,
  max_output_bytes INTEGER,
  allowed_modules TEXT,
  denied_modules TEXT,
  network_access INTEGER NOT NULL DEFAULT 0,
  filesystem_access TEXT NOT NULL DEFAULT 'none',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extraction_pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  stages TEXT NOT NULL,
  input_mime_types TEXT,
  max_input_size_bytes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifact_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_size_bytes INTEGER,
  allowed_types TEXT,
  retention_days INTEGER,
  require_versioning INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reliability_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  policy_type TEXT NOT NULL DEFAULT 'retry',
  max_retries INTEGER,
  initial_delay_ms INTEGER,
  max_delay_ms INTEGER,
  backoff_multiplier REAL,
  max_concurrent INTEGER,
  queue_size INTEGER,
  strategy TEXT,
  ttl_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trigger_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  expression TEXT,
  config TEXT,
  target_workflow TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_fired_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
