/**
 * Guardrail rules, evaluation records, and identity/RBAC rules.
 *
 * Relationships:
 *   guardrail_evals — soft-references chat_id and message_id
 */
export const SCHEMA_GUARDRAILS_SQL = `
CREATE TABLE IF NOT EXISTS guardrails (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'pre',
  config TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_conditions TEXT,              -- JSON ConditionNode; NULL = always run
  trigger_description TEXT,             -- human-readable summary of the condition
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guardrail_evals (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  message_id TEXT,
  stage TEXT NOT NULL,
  input_preview TEXT,
  results TEXT NOT NULL DEFAULT '[]',
  overall_decision TEXT NOT NULL DEFAULT 'allow',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  resource TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '*',
  roles TEXT,
  scopes TEXT,
  result TEXT NOT NULL DEFAULT 'allow',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
