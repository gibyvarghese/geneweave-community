/**
 * Migration m77 — General-Purpose Artifact Storage
 *
 * Introduces persistent, typed, versioned artifact storage for all agents.
 * Replaces the ad-hoc kaggle_run_artifacts approach with a first-class
 * artifact system backed by the @weaveintel/artifacts package.
 *
 * New tables:
 *
 *   artifacts          — Named, typed, versioned agent outputs
 *   artifact_versions  — Immutable version history per artifact
 *
 * Design decisions:
 *   - data stored as TEXT (JSON/text artifacts) OR BLOB (binary)
 *   - session_id + user_id + scope implement ADK-style session/user scoping
 *   - CASCADE DELETE on artifact_versions keeps DB consistent on artifact deletion
 *   - artifact_policies FK is nullable so artifacts can exist without a governance policy
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM77Artifacts(db: BetterSqlite3.Database): void {

  // ── 1. artifacts ─────────────────────────────────────────────────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS artifacts (
      id           TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      mime_type    TEXT    NOT NULL,
      data_text    TEXT,
      data_blob    BLOB,
      size_bytes   INTEGER,
      version      INTEGER NOT NULL DEFAULT 1,
      session_id   TEXT,
      user_id      TEXT,
      agent_id     TEXT,
      run_id       TEXT,
      tags         TEXT,     -- JSON string[]
      metadata     TEXT,     -- JSON object
      policy_id    TEXT      REFERENCES artifact_policies(id) ON DELETE SET NULL,
      scope        TEXT      NOT NULL DEFAULT 'session',
      created_at   TEXT      NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT
    )
  `);

  // ── 2. artifact_versions ──────────────────────────────────────────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS artifact_versions (
      id           TEXT    PRIMARY KEY,
      artifact_id  TEXT    NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      data_text    TEXT,
      data_blob    BLOB,
      changelog    TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(artifact_id, version)
    )
  `);

  // ── 3. Indexes ────────────────────────────────────────────────────────────────
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_session   ON artifacts(session_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_user      ON artifacts(user_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_agent     ON artifacts(agent_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_run       ON artifacts(run_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_type      ON artifacts(type)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_scope     ON artifacts(scope)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_policy    ON artifacts(policy_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artifacts_created   ON artifacts(created_at DESC)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artv_artifact       ON artifact_versions(artifact_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_artv_version        ON artifact_versions(artifact_id, version)`);
}
