import type BetterSqlite3 from 'better-sqlite3';

/**
 * m99 — Collaboration Phase 7: CRDT co-editing (human + agent co-edit one doc).
 *
 * A "co-edit doc" is a shared text document attached to a run that a human AND
 * the run's agent can edit at the SAME time, always converging (a CRDT — see
 * `@weaveintel/collab`). geneWeave is the TRUSTED RELAY: it holds the canonical
 * replica, validates every incoming edit, persists it, and fans it out live.
 *
 * Two tables (tenant-isolated by construction):
 *
 * 1. `coedit_docs` — one row per shared document. `snapshot_json` is the full
 *    CRDT state (every character + tombstone, in convergent order) — loading it
 *    reconstructs the exact replica. `state_vector_json` is the max op counter
 *    seen per site (for "what is a reconnecting peer missing"). `agent_written`
 *    tracks how many characters the agent peer has already contributed, so
 *    re-syncing the agent's streamed output is idempotent (never double-inserts).
 *
 * 2. `coedit_ops` — the append-only OP LOG: every insert/delete with its author
 *    site + Lamport counter (`op_site`/`op_counter` = the op's unique id). This
 *    is what lets an offline/reconnecting peer fetch EXACTLY the ops it missed
 *    (state-vector diff sync) instead of re-downloading the whole document.
 *
 * Security model (mid-2026 research — CRDTs are NOT Byzantine-tolerant, so the
 * server must enforce): an op's author site is derived from the authenticated
 * user (no forgery); ops are shape/size/flood validated before apply; only run
 * participants may edit; everything is tenant-scoped.
 */
export function applyM99Coedit(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coedit_docs (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id         TEXT,
      owner_id          TEXT NOT NULL,
      title             TEXT,
      snapshot_json     TEXT NOT NULL DEFAULT '{"nodes":[]}',  -- full CRDT state
      state_vector_json TEXT NOT NULL DEFAULT '{}',            -- max op counter per site
      agent_written     INTEGER NOT NULL DEFAULT 0,            -- chars the agent peer has streamed
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      UNIQUE(run_id)                                           -- one co-edit doc per run (idempotent)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coedit_docs_run ON coedit_docs(run_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS coedit_ops (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES coedit_docs(id) ON DELETE CASCADE,
      op_site    TEXT NOT NULL,        -- author site id (the op's unique id, part 1)
      op_counter INTEGER NOT NULL,     -- author Lamport counter (the op's unique id, part 2)
      op_json    TEXT NOT NULL,        -- the serialized RgaOp
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coedit_ops_doc  ON coedit_ops(doc_id, op_counter)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_coedit_ops_unique ON coedit_ops(doc_id, op_site, op_counter)`);
}
