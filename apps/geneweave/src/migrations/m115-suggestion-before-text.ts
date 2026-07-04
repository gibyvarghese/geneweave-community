import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m115 — weaveNotes: store the BEFORE text of an AI suggestion (track-changes diff).
 *
 * The design (GeneWeave Notes.dc.html) shows an AI edit INLINE in the note as a proper diff — the old
 * text struck through, the new text highlighted, and ✓ Accept / ✕ Reject right there. To render that
 * "old → new" diff we need the original text the suggestion replaces, captured when the suggestion is
 * staged. This adds `note_suggestions.before_text` (empty for append-only suggestions, which have no
 * "before"). Idempotent (safeExec ALTER).
 */
export function applyM115SuggestionBeforeText(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE note_suggestions ADD COLUMN before_text TEXT NOT NULL DEFAULT ''`);
}
