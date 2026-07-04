import type BetterSqlite3 from 'better-sqlite3';

/**
 * m79 — Artifact Streaming Status (Phase 4)
 *
 * Adds `streaming_status` and `streaming_progress` columns to the `artifacts`
 * table so the SSE endpoint and admin UI can distinguish actively-streaming
 * artifacts from completed ones without parsing JSON metadata.
 *
 * Column semantics:
 *   streaming_status  NULL = normal (not a streaming artifact)
 *                     'streaming' = generation in progress
 *                     'error'     = generation failed
 *   streaming_progress  0.0–1.0 fraction complete (updated on each update() call)
 *
 * Index `idx_artifacts_streaming` is partial so it doesn't bloat scans of
 * the common case (NULL rows).
 */
export function applyM79ArtifactStreaming(db: BetterSqlite3.Database): void {
  // streaming_status — nullable, only set during active streaming
  try {
    db.prepare(`
      ALTER TABLE artifacts
      ADD COLUMN streaming_status TEXT DEFAULT NULL
        CHECK(streaming_status IN ('streaming', 'error', NULL))
    `).run();
  } catch { /* column already exists */ }

  // streaming_progress — 0.0–1.0
  try {
    db.prepare(`
      ALTER TABLE artifacts
      ADD COLUMN streaming_progress REAL DEFAULT NULL
    `).run();
  } catch { /* column already exists */ }

  // Partial index — only indexes rows WHERE streaming_status IS NOT NULL
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_streaming
      ON artifacts(streaming_status)
     WHERE streaming_status IS NOT NULL
  `).run();
}
