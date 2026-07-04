import type BetterSqlite3 from 'better-sqlite3';

/**
 * m100 — weaveNotes Phase 2: collaborative NOTE co-editing + note sharing.
 *
 * Phase 7 (m99) made a RUN's text doc co-editable. Phase 2 does the same for a
 * NOTE — but a note is a STRUCTURED, rich-text document, so it is co-edited as
 * `BlockDoc` block-ops (`@weaveintel/collab`), and a note is USER-scoped (not tied
 * to a run), so it brings its own lightweight sharing model. geneWeave stays the
 * TRUSTED RELAY: it holds the canonical replica, validates every block-op, persists
 * it, and fans it out live over a per-note event stream.
 *
 * Four tables (all tenant-isolated by construction):
 *
 * 1. `note_coedit_docs` — one row per co-edited note. `snapshot_json` is the full
 *    `BlockDoc` CRDT state (every element + tombstone + LWW attrs + marks, in
 *    convergent order). `state_vector_json` is the max op counter seen per author
 *    site (for "what is a reconnecting peer missing"). One per note (idempotent).
 *
 * 2. `note_coedit_ops` — the append-only BLOCK-OP LOG: every op with its author
 *    site + Lamport counter (`op_site`/`op_counter` = the op's unique id). This is
 *    what lets an offline/reconnecting editor fetch EXACTLY the ops it missed
 *    (state-vector diff sync) instead of re-downloading the whole document.
 *
 * 3. `note_shares` — durable membership: who (besides the owner) may open a note
 *    and in what role (`viewer` reads, `collaborator` edits). UNIQUE(note,user)
 *    makes joining idempotent. The owner is implicit (resolved from the note),
 *    so only *other* people get rows here.
 *
 * 4. `note_share_tokens` — invite links: a 256-bit token, SHA-256-hashed at rest
 *    (plaintext never stored), carrying the role it grants, with optional expiry /
 *    max-uses / revocation — exactly the m95 run-sharing token design, note-scoped.
 *
 * Security model (mid-2026 research — CRDTs are NOT Byzantine-tolerant, so the
 * server must enforce): an op's author site is derived from the authenticated user
 * (no forgery); block-ops are shape/size/flood validated before apply; only the
 * owner or a `collaborator` may submit ops (viewers get 403); everything is
 * tenant-scoped; tokens are hashed and revocable.
 */
export function applyM100NoteCoedit(db: BetterSqlite3.Database): void {
  // 1. The canonical BlockDoc replica per note.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_coedit_docs (
      id                TEXT PRIMARY KEY,
      note_id           TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tenant_id         TEXT,
      owner_id          TEXT NOT NULL,
      snapshot_json     TEXT NOT NULL DEFAULT '{"elements":[],"attrs":[],"marks":[]}', -- full BlockDoc CRDT state
      state_vector_json TEXT NOT NULL DEFAULT '{}',                                    -- max op counter per author site
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      UNIQUE(note_id)                                                                  -- one co-edit doc per note (idempotent)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_coedit_docs_note ON note_coedit_docs(note_id)`);

  // 2. The append-only block-op log (state-vector diff sync / offline reconcile).
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_coedit_ops (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES note_coedit_docs(id) ON DELETE CASCADE,
      op_site    TEXT NOT NULL,        -- author site id (the op's unique id, part 1)
      op_counter INTEGER NOT NULL,     -- author Lamport counter (the op's unique id, part 2)
      op_json    TEXT NOT NULL,        -- the serialized BlockOp
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_coedit_ops_doc ON note_coedit_ops(doc_id, op_counter)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_note_coedit_ops_unique ON note_coedit_ops(doc_id, op_site, op_counter)`);

  // 3. Durable note membership (owner/collaborator/viewer; idempotent join).
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_shares (
      id                   TEXT PRIMARY KEY,
      note_id              TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tenant_id            TEXT,
      owner_id             TEXT NOT NULL,                  -- the note's owner (denormalized for access resolution)
      user_id              TEXT NOT NULL,                  -- the invited participant
      role                 TEXT NOT NULL DEFAULT 'viewer', -- 'collaborator' | 'viewer'
      joined_at            INTEGER NOT NULL,
      invited_via_token_id TEXT,
      UNIQUE(note_id, user_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_shares_user ON note_shares(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_shares_note ON note_shares(note_id)`);

  // 4. Invite links (256-bit token, SHA-256-hashed at rest, expirable/revocable).
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_share_tokens (
      id           TEXT PRIMARY KEY,
      note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tenant_id    TEXT,
      owner_id     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'viewer',  -- role granted on join
      token_hash   TEXT NOT NULL,                   -- SHA-256(token); plaintext never stored
      token_prefix TEXT NOT NULL,                   -- short hint (first 8 chars)
      max_uses     INTEGER,                         -- NULL = unlimited
      uses         INTEGER NOT NULL DEFAULT 0,
      expires_at   INTEGER,                         -- NULL = no expiry
      revoked_at   INTEGER,
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_share_tokens_note ON note_share_tokens(note_id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_note_share_tokens_hash ON note_share_tokens(token_hash)`);
}
