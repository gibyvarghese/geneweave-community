import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m112 — weaveNotes Phase 7: mobile (offline editing + ink + sync).
 *
 * Phase 7 brings notes to the phone with an offline-first editor. The capability is governed by
 * three Builder-editable settings (defaults match the package `DEFAULT_WEAVENOTES_CONFIG`):
 *   - `mobile_offline_enabled`     — allow offline editing + background sync (default on),
 *   - `mobile_ink_enabled`         — allow freehand ink on a phone/tablet (default on),
 *   - `mobile_offline_note_limit`  — how many notes the app caches on-device (default 200).
 *
 * No new tool/agent: a mobile edit syncs through the SAME REST routes as the web, and the existing
 * note ACTIVITY log records its provenance ("… on mobile") so the AI's `read_note_activity` tool
 * already understands what changed on a phone. Settings-only + idempotent (safeExec ALTERs).
 */
export function applyM112NotesMobile(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN mobile_offline_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN mobile_ink_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN mobile_offline_note_limit INTEGER NOT NULL DEFAULT 200`);
}
