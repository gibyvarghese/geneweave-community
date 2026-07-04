import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m121 — weaveNotes Phase 1 (visual correctness): VERIFY a visual before showing it.
 *
 * --- For someone new to this ---
 * When the assistant draws a diagram or finds a picture, it now CHECKS the result before staging it,
 * and retries if it's wrong — so a diagram actually covers what you asked for, and a found image
 * really depicts the subject (and is good quality + appropriate). These Builder-editable dials:
 *   - visual_verify_enabled        — turn the diagram quality-check + redraw loop on/off (default on)
 *   - visual_verify_threshold      — accept a diagram at this 0–1 structural score (default 0.7)
 *   - visual_verify_max_retries    — redraw a too-low diagram at most this many times (default 2)
 *   - image_verify_enabled         — turn the "does this picture really show X?" vision check on/off (on)
 *   - image_verify_min_confidence  — accept a found image at this 0–1 vision confidence (default 0.7)
 * Idempotent ALTERs (re-runnable).
 */
export function applyM121VisualVerify(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN visual_verify_enabled INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN visual_verify_threshold REAL NOT NULL DEFAULT 0.7');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN visual_verify_max_retries INTEGER NOT NULL DEFAULT 2');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN image_verify_enabled INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN image_verify_min_confidence REAL NOT NULL DEFAULT 0.7');
}
