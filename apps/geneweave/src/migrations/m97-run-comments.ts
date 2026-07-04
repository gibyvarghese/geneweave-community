import type BetterSqlite3 from 'better-sqlite3';

/**
 * m97 — Collaboration Phase 4: collaborative run timeline (comments, annotations,
 * public read-only share). Google-Docs-grade review on an AI run. Three tables,
 * each tenant-isolated by construction:
 *
 * 1. `run_comments` — THREADED comments anchored to a run part. Anchoring follows
 *    the mid-2026 research (Notion block comments + W3C TextQuoteSelector): we
 *    pin to a STABLE `anchor_part_id` (e.g. `tool-3`), record `anchor_seq` for
 *    staleness, and keep an optional fuzzy sub-range (`anchor_range_json`). A
 *    thread is the set of rows sharing `thread_id` (root.thread_id == root.id);
 *    `parent_id` records reply provenance. `body` is raw markdown (source of
 *    truth); `body_html` is the sanitized render cache. Soft-delete via
 *    `deleted_at` (tombstone — replies stay). Resolution is thread-level
 *    (`resolved_at`/`resolved_by` on the ROOT). `mentions_json` is the explicit
 *    @mention user-id list (notify off THIS, never by scanning the body).
 *
 * 2. `run_annotations` — structured quality SCORES / human feedback, in the
 *    cross-vendor LangSmith/Langfuse shape `{name, value, string_value, comment,
 *    source, data_type}` anchored to a run + optional part. Booleans normalise
 *    to 1/0 so thumbs aggregate; `source` separates HUMAN review from auto-graders.
 *    These are the "human feedback → eval dataset" bridge.
 *
 * 3. `run_public_shares` — a capability-URL token for a PUBLIC, read-only,
 *    redacted view of a run + its review. ≥128-bit CSPRNG, SHA-256-hashed at rest
 *    (plaintext shown once); expirable + revocable. Read-only is enforced
 *    server-side (the public route only ever GETs and redacts PII/internal ids).
 *
 * Security model (mid-2026 research): markdown is sanitized server-side (strict
 * allowlist — no raw HTML / `javascript:` survives); object-level authz on every
 * id (only run participants comment; author edits/deletes own; owner moderates +
 * resolves others'); @mentions validated against run access (fail closed); a
 * write field allowlist (clients can never set author/tenant/resolved/anchor).
 */
export function applyM97RunComments(db: BetterSqlite3.Database): void {
  // 1. Threaded, part-anchored comments.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_comments (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id       TEXT,
      thread_id       TEXT NOT NULL,           -- root comment id (root.thread_id == root.id)
      parent_id       TEXT,                    -- reply provenance; NULL for a root
      author_id       TEXT NOT NULL,
      body            TEXT NOT NULL,           -- raw markdown (source of truth)
      body_html       TEXT NOT NULL,           -- sanitized render cache
      mentions_json   TEXT NOT NULL DEFAULT '[]',
      anchor_part_id  TEXT NOT NULL DEFAULT '',-- stable reducer part id; '' = run-level
      anchor_seq      INTEGER NOT NULL DEFAULT 0,
      anchor_range_json TEXT,                  -- optional fuzzy sub-range selector
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      edited_at       INTEGER,                 -- body-change only → "(edited)"
      deleted_at      INTEGER,                 -- soft-delete tombstone
      deleted_by      TEXT,
      resolved_at     INTEGER,                 -- thread-level (set on the ROOT)
      resolved_by     TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_comments_run    ON run_comments(run_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_comments_thread ON run_comments(thread_id)`);

  // 2. Structured annotation scores (human feedback → evals).
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_annotations (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id    TEXT,
      part_id      TEXT NOT NULL DEFAULT '',   -- stable part id; '' = run-level
      author_id    TEXT NOT NULL,
      name         TEXT NOT NULL,              -- rubric / metric name
      data_type    TEXT NOT NULL DEFAULT 'numeric', -- numeric|categorical|boolean|text
      value        REAL,                       -- numeric value (bool true→1/false→0)
      string_value TEXT,                       -- categorical / text label
      comment      TEXT,
      source       TEXT NOT NULL DEFAULT 'human', -- human|llm_judge|eval_code|api|end_user
      created_at   INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_annotations_run  ON run_annotations(run_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_annotations_part ON run_annotations(run_id, part_id)`);

  // 3. Public read-only share tokens (capability URLs).
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_public_shares (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id    TEXT,
      token_hash   TEXT NOT NULL,              -- SHA-256(token); plaintext shown once
      token_prefix TEXT NOT NULL,              -- short non-secret lookup hint
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER,
      revoked_at   INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_public_shares_hash ON run_public_shares(token_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_public_shares_run  ON run_public_shares(run_id)`);
}
