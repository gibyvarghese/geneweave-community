import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m120 — weaveNotes Phase 0 hardening: per-USER AI rate limit (abuse + runaway-cost guard).
 *
 * --- For someone new to this ---
 * Every note "AI action" (rewrite, diagram, find-image, the agent, …) costs a model call, i.e. money.
 * Without a cap, one buggy script — or a prompt-injected agent stuck in a loop — could fire thousands
 * of AI requests a minute and run up a huge bill. This adds ONE Builder-editable dial:
 * `ai_rate_per_min_per_user` (default 30). The server keeps a per-user token bucket and, once a person
 * exceeds the configured actions-per-minute, every /ai/* note endpoint replies HTTP 429 with a
 * `Retry-After` header until the bucket refills. 30/min is generous for a real human but stops a
 * runaway cold. Idempotent ALTER (re-runnable).
 */
export function applyM120NoteAiRateLimit(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN ai_rate_per_min_per_user INTEGER NOT NULL DEFAULT 30');
}
