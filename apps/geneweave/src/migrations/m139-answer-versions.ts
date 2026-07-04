import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m139 — Regenerate an answer, keeping version history (Round 3 / H17).
 *
 * Regenerating an assistant answer must not throw the old one away. This keeps every generated answer for a
 * question turn as a VERSION the reader can page between ("‹ 2/3 ›"), lossless — exactly like ChatGPT/Claude.
 *
 *  • message_variants — the append-only history for one assistant "slot". `group_id` is the id of the
 *    assistant message in `messages` (the stable anchor); each row is one generated answer with its index,
 *    the model/provider that produced it, and why it exists ('original' | 'regenerate'). The `messages` row
 *    always mirrors the ACTIVE variant's text, so the normal transcript load is unchanged and every
 *    downstream reader (search, export, RAG) sees the answer the user currently has selected.
 *
 *  • tenant_answer_versions — per-tenant config: whether Regenerate is offered, and how many versions to keep
 *    per turn (the oldest are pruned first, never the one on screen).
 *
 * No new tool/agent: regenerating is a reader action, not an agent capability. Instead a regenerate is fed to
 * the platform's EXISTING routing quality signal (recordChatFeedbackSignal, signal='regenerate' → soft
 * negative), so the model-routing loop already understands "the reader wasn't satisfied and asked again".
 *
 * Idempotent.
 */
export function applyM139AnswerVersions(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS message_variants (
      id             TEXT PRIMARY KEY,
      group_id       TEXT NOT NULL,          -- the assistant messages.id this variant belongs to
      chat_id        TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      tenant_id      TEXT,
      variant_index  INTEGER NOT NULL,       -- 0-based order within the group (oldest first)
      content        TEXT NOT NULL,
      model          TEXT,
      provider       TEXT,
      reason         TEXT,                   -- 'original' | 'regenerate'
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_variants_group ON message_variants(group_id, variant_index)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_answer_versions (
      tenant_id     TEXT PRIMARY KEY,
      enabled       INTEGER NOT NULL DEFAULT 1,
      max_variants  INTEGER NOT NULL DEFAULT 5,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
