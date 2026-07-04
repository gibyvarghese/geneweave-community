import type BetterSqlite3 from 'better-sqlite3';

/**
 * m101 — weaveNotes Phase 3: AI co-author SUGGESTIONS (track-changes).
 *
 * Phase 2 made a note co-editable by humans. Phase 3 brings the AI INTO the note —
 * it can write directly (as a co-editing peer) OR propose changes a human reviews.
 * A "suggestion" is a staged set of block ops (an AI rewrite, a continuation, a
 * summary, an answer to "ask AI", or an agent `note_edit`) that is NOT yet part of
 * the canonical document: the human ACCEPTS it (the ops are applied + broadcast) or
 * REJECTS it (the ops are discarded). This is the mid-2026 best practice for AI
 * document editing — never silently mutate a human's document; stage and gate.
 *
 * One table:
 *   `note_suggestions` — each row is one pending/accepted/rejected proposal.
 *     - `ops_json` is the staged BlockOp[] (authored under a UNIQUE `author_site`
 *       so two pending suggestions never mint colliding op ids; the ops reference
 *       real element ids, so they still apply cleanly on accept even after other
 *       edits — RGA ops are position-independent).
 *     - `preview_text` is the human-readable Markdown the AI produced, for review.
 *     - `anchor_json` records what the suggestion targets (a block id / range / the
 *       end of the doc) for the reviewer UI.
 *
 * Security: a suggestion is scoped to its note (tenant-isolated via the note);
 * only a note owner/collaborator may create or resolve one; the staged ops are
 * never applied until an authorised human accepts (so a prompt-injected agent
 * cannot silently rewrite a document).
 */
export function applyM101NoteSuggestions(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_suggestions (
      id            TEXT PRIMARY KEY,
      note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      doc_id        TEXT NOT NULL,                  -- the note_coedit_docs row the ops target
      tenant_id     TEXT,
      author_kind   TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'user'
      author_id     TEXT NOT NULL,                  -- the user who triggered it (or the agent/run)
      author_site   TEXT NOT NULL,                  -- the unique CRDT site the staged ops are authored under
      action        TEXT NOT NULL,                  -- 'continue' | 'rewrite' | 'summarize' | 'ask' | 'note_edit' | 'ai_block'
      status        TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'accepted' | 'rejected'
      ops_json      TEXT NOT NULL,                  -- the staged BlockOp[]
      preview_text  TEXT NOT NULL DEFAULT '',       -- Markdown preview for the reviewer
      anchor_json   TEXT,                           -- what the suggestion targets (block id / range)
      created_at    INTEGER NOT NULL,
      resolved_at   INTEGER,
      resolved_by   TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_suggestions_note ON note_suggestions(note_id, status)`);
}
