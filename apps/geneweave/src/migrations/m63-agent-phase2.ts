/**
 * Migration m63 — Agent Phase 2 capabilities
 *
 * Adds DB-driven configuration for:
 *   P2-1  parallel_tool_calls  — per-chat parallel tool execution toggle
 *   P2-3  context management   — per-chat context window strategy + budget
 *   P2-4  tool retry           — per-chat transient-error retry settings
 *
 * New tables:
 *   agent_output_schemas    — reusable JSON schema registry for structured output
 *   agent_structured_outputs — append-only audit log of structured output events
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent — column / table may already exist */ }
}

export function applyM63AgentPhase2(db: BetterSqlite3.Database): void {
  // ── P2-1: Parallel tool execution ─────────────────────────────────────────
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN parallel_tool_calls INTEGER NOT NULL DEFAULT 1');

  // ── P2-3: Context window management ────────────────────────────────────────
  // strategy: 'trim_oldest' | 'sliding_window' | 'summarize' | NULL (disabled)
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN context_strategy TEXT');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN context_max_tokens INTEGER');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN context_window_size INTEGER NOT NULL DEFAULT 20');

  // ── P2-4: Tool retry ────────────────────────────────────────────────────────
  // max_attempts=0 means disabled (default).
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN tool_retry_max_attempts INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN tool_retry_backoff_ms INTEGER NOT NULL DEFAULT 200');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN tool_retry_max_backoff_ms INTEGER NOT NULL DEFAULT 10000');

  // ── agent_strategy_settings: propagate P2 defaults ─────────────────────────
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN parallel_tool_calls INTEGER NOT NULL DEFAULT 1');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN context_strategy TEXT');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN context_max_tokens INTEGER');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN context_window_size INTEGER NOT NULL DEFAULT 20');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN tool_retry_max_attempts INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN tool_retry_backoff_ms INTEGER NOT NULL DEFAULT 200');
  safe(db, 'ALTER TABLE agent_strategy_settings ADD COLUMN tool_retry_max_backoff_ms INTEGER NOT NULL DEFAULT 10000');

  // ── agent_output_schemas: reusable JSON schema registry ────────────────────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_output_schemas (
        id          TEXT PRIMARY KEY,
        -- Human-readable name shown in admin UI / logs
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        -- 'json_object' | 'json_schema'
        schema_type TEXT NOT NULL DEFAULT 'json_object',
        -- JSON string: the $schema or {type, properties, required, ...} object
        schema_json TEXT,
        -- Whether the model must strictly respect the schema (OpenAI strict mode)
        strict      INTEGER NOT NULL DEFAULT 0,
        -- Optional: scope to a specific chat_settings row (NULL = global)
        chat_id     TEXT REFERENCES chats(id) ON DELETE SET NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* already exists */ }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_output_schemas_name ON agent_output_schemas (name)`);
  } catch { /* already exists */ }

  // ── agent_structured_outputs: append-only audit log ────────────────────────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_structured_outputs (
        id            TEXT PRIMARY KEY,
        chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id    TEXT,
        agent_name    TEXT NOT NULL DEFAULT '',
        schema_name   TEXT,
        -- The parsed JSON stored as a TEXT blob for queryability
        output_json   TEXT NOT NULL,
        -- Number of retries needed before a valid response was produced
        retry_count   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* already exists */ }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_structured_outputs_chat ON agent_structured_outputs (chat_id, created_at)`);
  } catch { /* already exists */ }
}
