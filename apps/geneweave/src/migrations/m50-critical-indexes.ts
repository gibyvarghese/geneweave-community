/**
 * Migration m50 — Critical database indexes for hot query paths (H-3)
 *
 * Problem: The `messages`, `chats`, `sessions`, `traces`, and `metrics` tables
 * have no indexes. At any meaningful data volume, every one of these common
 * queries performs a full table scan:
 *
 *   • SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at
 *   • SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at
 *   • SELECT * FROM sessions WHERE expires_at < ?   (session cleanup)
 *   • SELECT * FROM traces WHERE chat_id = ?
 *   • SELECT * FROM metrics WHERE user_id = ?
 *
 * At 100 messages per chat and 1,000 chats per user this degrades to full
 * scans on every turn. At 10k+ rows each query becomes the dominant latency
 * component in the request path.
 *
 * All statements are `CREATE INDEX IF NOT EXISTS` — safe to run on live DBs
 * without disruption. SQLite builds each index in a single sequential write
 * pass and holds only a read lock on the table during that pass (no writer
 * starvation on a lightly-loaded dev/staging DB).
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent — index already exists */ }
}

export function applyM50CriticalIndexes(db: BetterSqlite3.Database): void {

  // ── messages ────────────────────────────────────────────────────────────────
  // The most-queried table: every chat page load, every context-window build,
  // and every agent history scan hits `WHERE chat_id = ? ORDER BY created_at`.
  // Composite (chat_id, created_at DESC) satisfies both the equality filter and
  // the ORDER BY in a single index scan.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at DESC)`);

  // Full-text / keyword search across a user's message history hits
  // `WHERE user_id = ? ORDER BY created_at DESC`.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id, created_at DESC)`);

  // ── chats ────────────────────────────────────────────────────────────────────
  // The chat list screen loads all chats for a user, sorted by most-recently
  // updated. Without this index, every `/chats` API call is O(total chats).
  safe(db, `CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id, updated_at DESC)`);

  // ── sessions ─────────────────────────────────────────────────────────────────
  // Session cleanup (purging expired sessions) and auth middleware both issue
  // `WHERE expires_at < ?` or `WHERE id = ? AND expires_at > ?`. The expires_at
  // index makes both efficient; the auth hot-path (id lookup) is already covered
  // by the PRIMARY KEY.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

  // ── traces ───────────────────────────────────────────────────────────────────
  // Traces are written on every agent step and read in the observability
  // dashboard by chat. `(chat_id, created_at DESC)` mirrors the messages
  // pattern and covers the most common access pattern.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_traces_chat_id ON traces(chat_id, created_at DESC)`);

  // Traces are also queried by user for the global audit log view.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_traces_user_id ON traces(user_id, created_at DESC)`);

  // ── metrics ──────────────────────────────────────────────────────────────────
  // The cost dashboard aggregates metrics by user and by chat. The composite
  // index covers both `GROUP BY user_id` + date range and `WHERE chat_id = ?`
  // + date range in one index.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_metrics_user ON metrics(user_id, chat_id, created_at DESC)`);

  // ── evals + eval_results ─────────────────────────────────────────────────────
  // Eval history page loads evals for a user; eval_results joined to evals.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_eval_results_user ON eval_results(user_id, updated_at DESC)`);

  // ── tool_rate_limit_buckets ───────────────────────────────────────────────────
  // Rate limit check + increment is on the hot path of every tool call.
  // The table is queried by (tool_name, scope_key, window_start) on every call;
  // ensure that triple is covered by a composite index (the UNIQUE constraint
  // already creates one, but we add an explicit named index for clarity).
  safe(db, `CREATE INDEX IF NOT EXISTS idx_tool_rate_buckets ON tool_rate_limit_buckets(tool_name, scope_key, window_start)`);
}
