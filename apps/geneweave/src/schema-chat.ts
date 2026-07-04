/**
 * Chat, messaging, metrics, tracing, and temporal tool tables.
 *
 * Relationships:
 *   chats → users
 *   messages → chats
 *   chat_settings → chats
 *   eval_results → users
 *   traces → users, chats
 *   temporal_* — scoped per conversation (scope_id)
 */
export const SCHEMA_CHAT_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'New Chat',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'agent',
  system_prompt TEXT,
  timezone TEXT,
  enabled_tools TEXT,
  redaction_enabled INTEGER NOT NULL DEFAULT 1,
  redaction_patterns TEXT,
  workers TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT,
  eval_name TEXT NOT NULL,
  score REAL NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  system_prompt TEXT,
  timezone TEXT,
  enabled_tools TEXT,
  redaction_enabled INTEGER NOT NULL DEFAULT 0,
  redaction_patterns TEXT,
  workers TEXT,
  -- M-19: Timestamp of when the settings snapshot (system_prompt, timezone,
  -- enabled_tools, redaction_patterns, workers) was captured. Without this
  -- column there is no way to determine whether the denormalised settings
  -- are current or were captured from an older version of the configuration,
  -- making reproducibility analysis impossible.
  settings_snapshot_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT,
  attributes TEXT,
  events TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS temporal_timers (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  label TEXT,
  duration_ms INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  stopped_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS temporal_stopwatches (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  label TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  stopped_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  laps_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS temporal_reminders (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);
`;
