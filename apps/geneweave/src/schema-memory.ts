/**
 * Memory system: governance rules, extraction rules, semantic/entity/episodic stores,
 * and memory extraction audit events.
 *
 * Relationships:
 *   semantic_memory → users, chats
 *   entity_memory → users, chats
 *   memory_extraction_events → users, chats
 */
export const SCHEMA_MEMORY_SQL = `
CREATE TABLE IF NOT EXISTS memory_governance (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  memory_types TEXT,
  tenant_id TEXT,
  block_patterns TEXT,
  redact_patterns TEXT,
  max_age TEXT,
  max_entries INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_extraction_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL,
  entity_type TEXT,
  pattern TEXT NOT NULL,
  flags TEXT,
  facts_template TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS semantic_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'semantic',
  source TEXT NOT NULL DEFAULT 'assistant',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'general',
  facts TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'regex',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, entity_name)
);

CREATE TABLE IF NOT EXISTS memory_extraction_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  self_disclosure INTEGER NOT NULL DEFAULT 0,
  regex_entities_count INTEGER NOT NULL DEFAULT 0,
  llm_entities_count INTEGER NOT NULL DEFAULT 0,
  merged_entities_count INTEGER NOT NULL DEFAULT 0,
  events TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
