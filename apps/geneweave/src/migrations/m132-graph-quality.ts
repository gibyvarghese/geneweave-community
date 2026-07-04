import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m132 — weaveNotes Phase 3: knowledge-graph QUALITY (GraphRAG-style).
 *
 * Two improvements to how the note knowledge graph is built:
 *
 *  1. Entity DISAMBIGUATION. The AI pulls people/orgs/concepts out of each note, but the same thing
 *     gets written many ways ("OpenAI" / "OpenAI, Inc." / "Open AI"; "WHO" / "World Health
 *     Organization"). We now store a CANONICAL key + display name next to each extracted entity so
 *     the graph groups every spelling as ONE node — and, crucially, CONNECTS the different notes that
 *     mention it. That turns a pile of names into a real graph.
 *       - note_entities.canonical_key / canonical_name (nullable for pre-m132 rows; recomputed on index)
 *       - an index on (user_id, canonical_key) so "which notes mention this entity?" is fast.
 *
 *  2. BATCHED embeddings. A workspace re-index now embeds many notes in ONE model call instead of one
 *     call per note (the old N+1 cost). The batch size is a Builder dial.
 *       - weavenotes_settings.entity_resolution_enabled (default on)
 *       - weavenotes_settings.embedding_batch_size (default 16)
 * Idempotent.
 */
export function applyM132GraphQuality(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE note_entities ADD COLUMN canonical_key TEXT`);
  safeExec(db, `ALTER TABLE note_entities ADD COLUMN canonical_name TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_note_entities_canon ON note_entities(user_id, canonical_key)`);

  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN entity_resolution_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN embedding_batch_size INTEGER NOT NULL DEFAULT 16`);
}
