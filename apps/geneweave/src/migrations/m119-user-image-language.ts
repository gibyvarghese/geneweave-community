import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m119 — weaveNotes: per-USER preferred language for sourced images (default English).
 *
 * find_image pulls real images from the web, and an image's labels (especially diagrams) may be in
 * any language — a French or German heart diagram is the "right" subject but the wrong language. So
 * each user gets a preferred image language (default 'en') that steers the search query, the
 * candidate ranking, and a filename-language filter. It lives on `user_preferences` (per user), and
 * is read at find_image time + editable via GET/PUT /api/me/notes/image-language. Idempotent ALTER.
 */
export function applyM119UserImageLanguage(db: BetterSqlite3.Database): void {
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN notes_image_language TEXT NOT NULL DEFAULT 'en'");
}
