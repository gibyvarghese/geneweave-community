import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m130 — weaveNotes Phase 3: MCP server for the note vault.
 *
 * Exposes a user's notes to an EXTERNAL agent (Claude Desktop / ChatGPT / Cursor) over the Model
 * Context Protocol, so they can search/read/create/append notes. The external client authenticates
 * with a PER-USER personal access token (a bearer token), validated server-side and resolved to ONE
 * user — every tool call is then owner-scoped to that user (the identity comes from the TOKEN, never
 * from a tool argument: the #1 MCP-security control). Tokens are stored HASHED (SHA-256); the
 * plaintext is shown to the user once at creation.
 *
 *   - user_mcp_tokens — per-user bearer tokens (read or read+write scope, revocable, optional expiry).
 *   - weavenotes_settings.mcp_notes_enabled / mcp_notes_allow_writes — global Builder dials.
 * Idempotent.
 */
export function applyM130McpNotes(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS user_mcp_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      name TEXT NOT NULL DEFAULT 'MCP token',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'readwrite',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_user_mcp_tokens_user ON user_mcp_tokens(user_id, enabled)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_user_mcp_tokens_hash ON user_mcp_tokens(token_hash)`);

  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN mcp_notes_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN mcp_notes_allow_writes INTEGER NOT NULL DEFAULT 1`);
}
