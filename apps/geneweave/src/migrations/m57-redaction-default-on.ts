/**
 * Migration m57 — Flip redaction_enabled default to ON (Wave 2 / M4-5)
 *
 * Audit finding M4-5: 96% of chat_settings rows (2,085/2,180) had
 * redaction_enabled = 0 because the in-code DEFAULT_SETTINGS.redactionEnabled
 * was false.  The application always writes an explicit value on INSERT so the
 * DB column DEFAULT 1 was never reached.
 *
 * This migration:
 *   1. Backfills all existing rows to redaction_enabled = 1.
 *   2. Clears input_preview on all guardrail_evals rows so existing PII
 *      captured before this fix is no longer stored in the audit table.
 *
 * The in-code default has been changed to true in the same commit, so new
 * chat_settings rows will be written with redaction_enabled = 1 going forward.
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM57RedactionDefaultOn(db: BetterSqlite3.Database): void {
  db.exec(`UPDATE chat_settings SET redaction_enabled = 1 WHERE redaction_enabled = 0`);
  db.exec(`UPDATE guardrail_evals SET input_preview = NULL WHERE input_preview IS NOT NULL`);
}
