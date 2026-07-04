import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m107 — weaveNotes Phase 3: live-collaboration settings.
 *
 * Phase 3 turns the note's co-editing room into a VISIBLE multiplayer space: live collaborator
 * cursors (coloured carets + names) and the AI shown as a participant while it works. Both are
 * configuration-as-data, tuned in the Builder's weaveNotes Settings — so this migration adds two
 * flags to `weavenotes_settings`:
 *
 *   - `live_cursors_enabled` — show each other person's caret + name live while co-editing.
 *   - `ai_presence_enabled`  — announce the AI as a live participant ("weaveIntel AI") while it
 *                              edits or colour-codes a note.
 *
 * Both default ON. Idempotent (safeExec no-ops if the column already exists).
 */
export function applyM107NoteLivePresence(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN live_cursors_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN ai_presence_enabled INTEGER NOT NULL DEFAULT 1`);
}
