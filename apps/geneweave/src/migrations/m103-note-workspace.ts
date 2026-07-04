import type BetterSqlite3 from 'better-sqlite3';

/**
 * m103 — weaveNotes Phase 8: workspace RAG + version history + comments + synced blocks.
 *
 * Phase 5 connected notes into a graph; Phase 8 turns the whole workspace into something you
 * can ASK, REVIEW, and TRUST over time. Four new tables:
 *
 *   - `run_embeddings` — one vector per chat RUN's output, the run-side twin of the Phase 5
 *     `note_embeddings`. Together they let "summarize what we learned about X" search across
 *     BOTH your notes and your past chats and answer with click-to-source citations (RAG).
 *
 *   - `note_versions` — a per-note timeline of saved snapshots (the note's `doc_json` at a
 *     point in time) so you can see history and RESTORE an older version. A restore first
 *     snapshots the current state, so it is always undoable.
 *
 *   - `note_comments` — threaded, BLOCK-ANCHORED review comments on a note (mirrors the
 *     Phase 4 `run_comments` design: stable anchor, raw markdown + sanitized html, soft-delete
 *     tombstones, thread-level resolve). Anchored to a CRDT block id so a comment sticks to its
 *     paragraph even as the note is co-edited.
 *
 *   - `note_synced_blocks` — transclusion: a block in one note that MIRRORS a block from
 *     another note. Resolved read-through (always shows the source's current text), so editing
 *     the source updates every place it is synced — no propagation needed.
 *
 * All rows are owner-scoped (user_id) + tenant-isolated.
 */
export function applyM103NoteWorkspace(db: BetterSqlite3.Database): void {
  // One embedding vector per chat run's concatenated text output (workspace RAG over runs).
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_embeddings (
      run_id        TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      tenant_id     TEXT,
      dim           INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,  -- JSON number[] (the vector)
      content_hash  TEXT NOT NULL,   -- skip re-embedding when the run output is unchanged
      title         TEXT,            -- a short label (first line of output) for display
      content       TEXT,            -- the (truncated) run text, for building cited snippets
      updated_at    INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_embeddings_user ON run_embeddings(user_id)`);

  // A per-note version timeline: each row is a snapshot of the note's doc_json at a moment.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_versions (
      id          TEXT PRIMARY KEY,
      note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      tenant_id   TEXT,
      title       TEXT NOT NULL,         -- the note's title at snapshot time
      doc_json    TEXT NOT NULL,         -- the full ProseMirror doc at snapshot time
      label       TEXT,                  -- optional human label ("before restore", "v1", …)
      reason      TEXT NOT NULL DEFAULT 'manual', -- manual | restore | autosave | publish
      word_count  INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, created_at)`);

  // Threaded, block-anchored review comments on a note (mirrors run_comments / m97).
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_comments (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tenant_id       TEXT,
      thread_id       TEXT NOT NULL,            -- root comment id (root.thread_id == root.id)
      parent_id       TEXT,                     -- reply provenance; NULL for a root
      author_id       TEXT NOT NULL,
      body            TEXT NOT NULL,            -- raw markdown (source of truth)
      body_html       TEXT NOT NULL,            -- sanitized render cache
      mentions_json   TEXT NOT NULL DEFAULT '[]',
      anchor_block_id TEXT NOT NULL DEFAULT '', -- stable CRDT block id; '' = note-level
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      edited_at       INTEGER,                  -- body-change only → "(edited)"
      deleted_at      INTEGER,                  -- soft-delete tombstone
      deleted_by      TEXT,
      resolved_at     INTEGER,                  -- thread-level (set on the ROOT)
      resolved_by     TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_comments_note   ON note_comments(note_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_comments_thread ON note_comments(thread_id)`);

  // Synced blocks (transclusion): a block in note_id mirrors source_block_id from source_note_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_synced_blocks (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,   -- where it is shown
      user_id         TEXT NOT NULL,
      tenant_id       TEXT,
      source_note_id  TEXT NOT NULL,        -- the note the content comes from
      source_block_id TEXT NOT NULL DEFAULT '', -- the block id in the source ('' = whole note)
      created_at      INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_synced_note   ON note_synced_blocks(note_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_synced_source ON note_synced_blocks(source_note_id)`);
}
