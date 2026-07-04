/**
 * Agent infrastructure: skills, worker agents, replay scenarios,
 * and developer-experience tables (scaffold templates, recipe configs,
 * widget configs, validation rules).
 *
 * Relationships:
 *   worker_agents → task_contracts
 */
export const SCHEMA_AGENTS_SQL = `
-- ── Skills: reusable agent capability bundles ──────────────

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  -- JSON string[] — phrases that trigger this skill via pattern matching
  trigger_patterns TEXT NOT NULL DEFAULT '[]',
  -- System-prompt snippet injected when this skill is active
  instructions TEXT NOT NULL DEFAULT '',
  -- JSON string[] — tool names to make available when skill is active
  tool_names TEXT,
  -- JSON array of {input,output} examples (few-shot demonstrations)
  examples TEXT,
  -- JSON string[] — searchable tags
  tags TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '1.0',
  -- Phase 6: optional key referencing a tool_policies row; overrides the global tool policy for all tool calls while this skill is active
  tool_policy_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Worker Agents: database-driven supervisor workers ──────

CREATE TABLE IF NOT EXISTS worker_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  job_profile TEXT,
  description TEXT NOT NULL DEFAULT '',
  -- System prompt / instructions for this worker
  system_prompt TEXT NOT NULL DEFAULT '',
  -- JSON string[] — tool names available to this worker
  tool_names TEXT NOT NULL DEFAULT '[]',
  -- RBAC persona for tool filtering (e.g. 'agent_worker', 'agent_researcher')
  persona TEXT NOT NULL DEFAULT 'agent_worker',
  -- JSON string[] — trigger patterns for auto-routing (supervisor uses these to decide when to delegate)
  trigger_patterns TEXT,
  -- Optional task contract ID for completion validation
  task_contract_id TEXT REFERENCES task_contracts(id),
  -- Max retry attempts when contract validation fails
  max_retries INTEGER NOT NULL DEFAULT 0,
  -- Priority for ordering when building supervisor worker list (higher = listed first)
  priority INTEGER NOT NULL DEFAULT 0,
  -- Feature grouping: 'general' | 'hypothesis-validation' | other domain categories
  -- Workers with category != 'general' are excluded from the main chat supervisor dispatch list
  category TEXT NOT NULL DEFAULT 'general',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS replay_scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  golden_prompt TEXT NOT NULL,
  golden_response TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  tags TEXT,
  acceptance_criteria TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 9: Developer Experience ──────────────────────────

CREATE TABLE IF NOT EXISTS scaffold_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  template_type TEXT NOT NULL DEFAULT 'basic-agent',
  files TEXT,
  dependencies TEXT,
  dev_dependencies TEXT,
  variables TEXT,
  post_install TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  recipe_type TEXT NOT NULL DEFAULT 'workflow',
  model TEXT,
  provider TEXT,
  system_prompt TEXT,
  tools TEXT,
  guardrails TEXT,
  max_steps INTEGER DEFAULT 10,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS widget_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  widget_type TEXT NOT NULL DEFAULT 'table',
  default_options TEXT,
  allowed_contexts TEXT,
  max_data_points INTEGER DEFAULT 1000,
  refresh_interval_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS validation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL DEFAULT 'required',
  target TEXT NOT NULL DEFAULT 'agent-config',
  condition TEXT,
  severity TEXT NOT NULL DEFAULT 'error',
  message TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
