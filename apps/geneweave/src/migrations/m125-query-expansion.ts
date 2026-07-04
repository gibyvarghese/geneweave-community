import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m125 — weaveNotes Phase 2: query expansion for "Ask your workspace" / workspace search.
 *
 * Two Builder-editable dials:
 *   - query_expansion_enabled  — rephrase the question a few ways AND write a hypothetical answer
 *                                (HyDE), then search with all of them so more relevant notes/chats
 *                                surface (costs one small extra model call + a few embeddings).
 *   - query_expansion_variants — how many alternative phrasings to generate (2–4).
 * Idempotent ALTERs.
 */
export function applyM125QueryExpansion(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN query_expansion_enabled INTEGER NOT NULL DEFAULT 1');
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN query_expansion_variants INTEGER NOT NULL DEFAULT 3');
}
