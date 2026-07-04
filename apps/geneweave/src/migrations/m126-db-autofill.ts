import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m126 — weaveNotes Phase 2: relation-aware + PII-safe database AUTO-FILL.
 *
 * Two Builder-editable dials governing the AI column auto-fill:
 *   - db_autofill_web_search  — may auto-fill consult the WEB for a value (off → only the row's own
 *                               fields + its RELATED rows are used as context).
 *   - db_autofill_redact_pii  — scrub personal data (emails, phones, card/SSN-like numbers) out of the
 *                               outbound web-search query so a row's PII never leaves to the engine.
 * (Relation-awareness — feeding a row's linked rows in as context — is always on; it needs no flag.)
 * Idempotent ALTERs.
 */
export function applyM126DbAutofill(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN db_autofill_web_search INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN db_autofill_redact_pii INTEGER NOT NULL DEFAULT 1');
}
