import type BetterSqlite3 from 'better-sqlite3';

/**
 * m102 — weaveNotes Phase 5: the notes KNOWLEDGE GRAPH.
 *
 * Phases 1–4 made a note a living, co-edited, publishable document. Phase 5 connects
 * notes into a web of meaning — the Obsidian/Tana idea — so the workspace becomes
 * more than a pile of pages:
 *
 *   - `[[wiki-links]]` between notes are stored in the existing `note_links` table
 *     (m46), giving "backlinks" for free. (No new table needed for links.)
 *   - `note_entities` / `note_relations` hold the ENTITIES (people, orgs, concepts,
 *     technologies…) and RELATIONS (subject —predicate→ object) an LLM extracts from a
 *     note — the raw material of a browsable knowledge graph.
 *   - `note_embeddings` holds one vector per note so we can surface "related notes"
 *     by semantic similarity (cosine), not just by explicit links.
 *
 * All rows are owner-scoped (user_id) + tenant-isolated, and keyed by note so a note's
 * graph contribution is replaced wholesale when it is re-indexed (idempotent).
 */
export function applyM102NoteGraph(db: BetterSqlite3.Database): void {
  // Entities extracted from a note (people / orgs / concepts / technologies / …).
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_entities (
      id         TEXT PRIMARY KEY,
      note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      tenant_id  TEXT,
      name       TEXT NOT NULL,
      name_key   TEXT NOT NULL,   -- lowercased name, for co-occurrence / graph joins
      type       TEXT NOT NULL DEFAULT 'other',
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_entities_note ON note_entities(note_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_entities_user ON note_entities(user_id, name_key)`);

  // Relations (a small sentence: subject —predicate→ object) extracted from a note.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_relations (
      id         TEXT PRIMARY KEY,
      note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      tenant_id  TEXT,
      subject    TEXT NOT NULL,
      predicate  TEXT NOT NULL,
      object     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_relations_note ON note_relations(note_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_relations_user ON note_relations(user_id)`);

  // One embedding vector per note (for semantic "related notes").
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_embeddings (
      note_id       TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL,
      tenant_id     TEXT,
      dim           INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,  -- JSON number[] (the vector)
      content_hash  TEXT NOT NULL,   -- skip re-embedding when content is unchanged
      title         TEXT,            -- denormalized for cheap related-notes display
      updated_at    INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_embeddings_user ON note_embeddings(user_id)`);
}
