/**
 * anyWeave Task-Aware Routing — model selection, capability scoring, feedback loop,
 * surface items, and A/B routing experiments.
 *
 * NOTE: ALTER TABLE additions for agents / model_pricing / routing_policies
 * live in db-sqlite-migrations.ts. The CREATE TABLEs here are mirrored so
 * fresh installs get the schema in one shot.
 *
 * Relationships:
 *   routing_capability_signals — soft-references model_capability_scores
 *   routing_decision_traces — standalone audit log
 *   routing_experiments — references task_key + tenant_id (soft)
 */
export const SCHEMA_ROUTING_SQL = `
CREATE TABLE IF NOT EXISTS routing_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  strategy TEXT NOT NULL DEFAULT 'priority',
  constraints TEXT,
  weights TEXT,
  fallback_model TEXT,
  fallback_provider TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_pricing (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  input_cost_per_1m REAL NOT NULL DEFAULT 0,
  output_cost_per_1m REAL NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0.7,
  source TEXT NOT NULL DEFAULT 'manual',
  last_synced_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  prompt_cache_enabled INTEGER NOT NULL DEFAULT 1,
  prompt_cache_min_tokens INTEGER NOT NULL DEFAULT 1024,
  prompt_cache_ttl TEXT NOT NULL DEFAULT '5m',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(model_id, provider)
);

-- ─── anyWeave Task-Aware Routing (Phase 1) ────────────────────

CREATE TABLE IF NOT EXISTS task_type_definitions (
  id              TEXT PRIMARY KEY,
  task_key        TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  output_modality TEXT NOT NULL,
  default_strategy TEXT NOT NULL,
  default_weights TEXT NOT NULL DEFAULT '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}',
  inference_hints TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_types_category ON task_type_definitions(category, enabled);

CREATE TABLE IF NOT EXISTS model_capability_scores (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT,
  model_id            TEXT NOT NULL,
  provider            TEXT NOT NULL,
  task_key            TEXT NOT NULL,
  quality_score       REAL NOT NULL,
  supports_tools      INTEGER NOT NULL DEFAULT 1,
  supports_streaming  INTEGER NOT NULL DEFAULT 1,
  supports_thinking   INTEGER NOT NULL DEFAULT 0,
  supports_json_mode  INTEGER NOT NULL DEFAULT 0,
  supports_vision     INTEGER NOT NULL DEFAULT 0,
  max_output_tokens   INTEGER,
  benchmark_source    TEXT,
  raw_benchmark_score REAL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  last_evaluated_at   TEXT,
  production_signal_score REAL,
  signal_sample_count INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, model_id, provider, task_key)
);
CREATE INDEX IF NOT EXISTS idx_capability_lookup ON model_capability_scores(task_key, is_active, tenant_id);
CREATE INDEX IF NOT EXISTS idx_capability_model ON model_capability_scores(model_id, provider);

CREATE TABLE IF NOT EXISTS task_type_tenant_overrides (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  task_key              TEXT NOT NULL,
  weights               TEXT,
  preferred_model_id    TEXT,
  preferred_provider    TEXT,
  preferred_boost_pct   REAL NOT NULL DEFAULT 20,
  cost_ceiling_per_call REAL,
  optimisation_strategy TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, task_key)
);

CREATE TABLE IF NOT EXISTS provider_tool_adapters (
  id                        TEXT PRIMARY KEY,
  provider                  TEXT NOT NULL UNIQUE,
  display_name              TEXT NOT NULL,
  adapter_module            TEXT NOT NULL,
  tool_format               TEXT NOT NULL,
  tool_call_response_format TEXT NOT NULL,
  tool_result_format        TEXT NOT NULL,
  system_prompt_location    TEXT NOT NULL DEFAULT 'system_message',
  name_validation_regex     TEXT NOT NULL DEFAULT '^[a-zA-Z0-9_-]{1,64}$',
  max_tool_count            INTEGER NOT NULL DEFAULT 128,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routing_decision_traces (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT,
  agent_id                  TEXT,
  workflow_step_id          TEXT,
  task_key                  TEXT,
  inference_source          TEXT,
  selected_model_id         TEXT NOT NULL,
  selected_provider         TEXT NOT NULL,
  selected_capability_score REAL,
  weights_used              TEXT NOT NULL,
  candidate_breakdown       TEXT NOT NULL,
  tool_translation_applied  INTEGER NOT NULL DEFAULT 0,
  source_provider           TEXT,
  estimated_cost_usd        REAL,
  decided_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_task ON routing_decision_traces(task_key, decided_at);
CREATE INDEX IF NOT EXISTS idx_decision_tenant ON routing_decision_traces(tenant_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_decision_agent ON routing_decision_traces(agent_id, decided_at);

-- ─── Phase 5 — Feedback loop ─────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_capability_signals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  model_id      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  task_key      TEXT NOT NULL,
  source        TEXT NOT NULL,
  signal_type   TEXT NOT NULL,
  value         REAL NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  evidence_id   TEXT,
  message_id    TEXT,
  trace_id      TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_lookup ON routing_capability_signals(model_id, provider, task_key, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_source ON routing_capability_signals(source, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_tenant ON routing_capability_signals(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS message_feedback (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  chat_id     TEXT,
  user_id     TEXT,
  signal      TEXT NOT NULL,
  comment     TEXT,
  model_id    TEXT,
  provider    TEXT,
  task_key    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_message ON message_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_signal ON message_feedback(signal, created_at);

CREATE TABLE IF NOT EXISTS routing_surface_items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  task_key        TEXT NOT NULL,
  tenant_id       TEXT,
  message         TEXT NOT NULL,
  metric_7d       REAL,
  metric_30d      REAL,
  drop_pct        REAL,
  sample_count_7d INTEGER,
  sample_count_30d INTEGER,
  auto_disabled   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_surface_status ON routing_surface_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_surface_model ON routing_surface_items(model_id, provider, task_key);

-- anyWeave Phase 6: A/B routing experiments.
-- For (task_key, tenant_id) tuples, route a percentage of traffic from
-- baseline_model_id → candidate_model_id and compare downstream quality.
CREATE TABLE IF NOT EXISTS routing_experiments (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  tenant_id             TEXT,
  task_key              TEXT,
  baseline_provider     TEXT NOT NULL,
  baseline_model_id     TEXT NOT NULL,
  candidate_provider    TEXT NOT NULL,
  candidate_model_id    TEXT NOT NULL,
  traffic_pct           REAL NOT NULL DEFAULT 10,
  status                TEXT NOT NULL DEFAULT 'active',
  metadata              TEXT,
  started_at            TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at              TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_experiments_lookup ON routing_experiments(status, task_key, tenant_id);
`;
