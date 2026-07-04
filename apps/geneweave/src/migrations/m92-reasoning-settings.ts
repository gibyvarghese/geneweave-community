import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration m92 — Reasoning / thinking request settings.
 *
 * Lets a chat (and a `/api/me/runs` run) REQUEST provider reasoning so
 * reasoning-capable models actually emit reasoning frames (Anthropic extended
 * thinking; OpenAI reasoning effort). Mirrors the m40 `chat_settings` ALTER
 * pattern. The request is applied only when the chat's model is
 * reasoning-capable (`model_capability_scores.supports_thinking = 1`).
 *
 *   - reasoning_enabled        — request reasoning for this chat (0/1)
 *   - reasoning_effort         — 'low' | 'medium' | 'high' (OpenAI; maps to a
 *                                default Anthropic thinking budget)
 *   - reasoning_budget_tokens  — explicit Anthropic thinking budget (0 = derive
 *                                from effort)
 */
function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent — column may already exist */ }
}

export function applyM92ReasoningSettings(db: BetterSqlite3.Database): void {
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN reasoning_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, "ALTER TABLE chat_settings ADD COLUMN reasoning_effort TEXT");
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN reasoning_budget_tokens INTEGER NOT NULL DEFAULT 0');
}
