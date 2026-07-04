import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m123 — weaveNotes Phase 2: FSRS spaced repetition for flashcards (upgrade from SM-2).
 *
 * --- For someone new to this ---
 * Flashcards are reviewed "just before you'd forget", on a schedule. The old maths (SM-2) is a fixed
 * rule of thumb; FSRS (the Free Spaced Repetition Scheduler — what modern Anki uses) models your
 * MEMORY of each card with two numbers and predicts the forgetting curve far more accurately, so you
 * review less and remember more. Each card now also stores:
 *   - stability   — roughly "how many days until you'd have a 90% chance of recalling it" (grows as you learn)
 *   - difficulty  — 1–10, how intrinsically hard the card is for you
 * And two Builder-editable dials:
 *   - fsrs_enabled          — use FSRS (on) or fall back to the classic SM-2 (off)
 *   - fsrs_target_retention — the recall probability you aim for at review time (default 0.90 = review
 *                             when you'd have ~90% chance of remembering; higher = more frequent reviews)
 * Idempotent ALTERs (re-runnable). Existing cards keep working; stability/difficulty fill in on first
 * FSRS review (NULL until then, treated as "fresh").
 */
export function applyM123Fsrs(db: BetterSqlite3.Database): void {
  // Per-card FSRS memory state (NULL until the card's first FSRS review).
  safeExec(db, 'ALTER TABLE note_flashcards ADD COLUMN stability REAL');
  safeExec(db, 'ALTER TABLE note_flashcards ADD COLUMN difficulty REAL');
  // Builder-editable scheduler config.
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN fsrs_enabled INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN fsrs_target_retention REAL NOT NULL DEFAULT 0.9');
}
