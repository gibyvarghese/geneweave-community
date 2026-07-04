import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m122 — weaveNotes Phase 2: "Ask your workspace" with VERIFIED character-level citations.
 *
 * --- For someone new to this ---
 * When you ask a question about your own notes, the assistant answers FROM them and shows, for each
 * point, the EXACT line it came from — and we double-check that line really exists in the note before
 * showing it (so it can't make up a quote). Two Builder-editable dials:
 *   - citations_enabled      — turn cited answers on/off (off → Ask just lists matching notes)
 *   - citation_max_sources   — how many notes a single answer may draw on (default 6)
 * Idempotent ALTERs.
 */
export function applyM122Citations(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN citations_enabled INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN citation_max_sources INTEGER NOT NULL DEFAULT 6');
}
