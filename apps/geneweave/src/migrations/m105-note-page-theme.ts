import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m105 — weaveNotes Phase 1: per-note page theme + freeform canvas + cover image.
 *
 * Phase 1 gives a note a creative SURFACE it can wear (spec §10.6 — the Pro ↔ Creative
 * theme toggle). That choice lives on the note, not just in the global default, so a note
 * remembers which "outfit" it opens in. This migration adds three columns to `notes`:
 *
 *   - `page_theme`             — 'pro' (clean) | 'creative' (warm paper). A NEW note adopts the
 *                                weaveNotes default theme (weavenotes_settings.default_theme);
 *                                the toggle in the editor persists the per-note choice here.
 *   - `freeform_mode`          — 0/1: drop the single-column grid for a free canvas layout.
 *   - `cover_image_artifact_id`— optional banner image (a generated/uploaded artifact id).
 *
 * Existing notes keep the safe default ('pro', not freeform, no cover) — zero behaviour change.
 * `safeExec` makes the ALTERs idempotent (a re-run on a DB that already has the column is a no-op).
 */
export function applyM105NotePageTheme(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE notes ADD COLUMN page_theme TEXT NOT NULL DEFAULT 'pro'`);
  safeExec(db, `ALTER TABLE notes ADD COLUMN freeform_mode INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE notes ADD COLUMN cover_image_artifact_id TEXT`);
}
