/**
 * Prompt management tables: templates, versioning, experiments, eval, and optimization.
 *
 * Relationships:
 *   prompt_versions → prompts
 *   prompt_experiments → prompts
 *   prompt_eval_datasets → prompts
 *   prompt_eval_runs → prompt_eval_datasets, prompts
 *   prompt_optimization_runs → prompts, prompt_optimizers
 */
export const SCHEMA_PROMPTS_SQL = `
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  prompt_type TEXT NOT NULL DEFAULT 'template',
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  tags TEXT,
  template TEXT NOT NULL,
  variables TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  model_compatibility TEXT,
  execution_defaults TEXT,
  framework TEXT,
  metadata TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_frameworks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sections TEXT NOT NULL DEFAULT '[]',
  section_separator TEXT NOT NULL DEFAULT '\n\n',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_fragments (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  content TEXT NOT NULL,
  variables TEXT,
  tags TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_contracts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  contract_type TEXT NOT NULL,
  schema TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_strategies (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  instruction_prefix TEXT,
  instruction_suffix TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  template TEXT NOT NULL,
  variables TEXT,
  model_compatibility TEXT,
  execution_defaults TEXT,
  framework TEXT,
  metadata TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(prompt_id, version)
);

CREATE TABLE IF NOT EXISTS prompt_experiments (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  variants_json TEXT NOT NULL DEFAULT '[]',
  assignment_key_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_eval_datasets (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  prompt_version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  pass_threshold REAL NOT NULL DEFAULT 0.75,
  cases_json TEXT NOT NULL DEFAULT '[]',
  rubric_json TEXT,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_eval_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES prompt_eval_datasets(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_version TEXT NOT NULL,
  -- L-15: Default status is 'pending' — a run starts pending and transitions
  -- to 'running', then 'completed' or 'failed'. The previous default of
  -- 'completed' caused dashboard filters to show unsettled runs as finished.
  status TEXT NOT NULL DEFAULT 'pending',
  avg_score REAL NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  total_cases INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS prompt_optimizers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  implementation_kind TEXT NOT NULL DEFAULT 'rule',
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_optimization_runs (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  source_version TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  optimizer_id TEXT REFERENCES prompt_optimizers(id) ON DELETE SET NULL,
  objective TEXT NOT NULL,
  source_template TEXT NOT NULL,
  candidate_template TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  eval_baseline_json TEXT,
  eval_candidate_json TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
