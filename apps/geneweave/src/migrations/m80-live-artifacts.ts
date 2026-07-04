import type BetterSqlite3 from 'better-sqlite3';

/**
 * m80 — Live Artifact Configs (Phase 6)
 *
 * Adds `live_artifact_configs` table so any stored artifact can be wired to a
 * refresh source — either a registered MCP tool or an inline refreshFn callback.
 * On `POST /api/artifacts/:id/refresh` the server calls the tool, writes a new
 * artifact version, and records `last_refreshed_at`.
 *
 * refresh_interval_seconds = 0  → manual only (no auto-refresh)
 * refresh_interval_seconds > 0  → client auto-refreshes at this cadence
 *
 * cache_ttl_seconds: if the last refresh was within this window, the server
 * returns `{ fromCache: true }` rather than calling the MCP tool again —
 * prevents hammering external services when many clients open the same artifact.
 */
export function applyM80LiveArtifacts(db: BetterSqlite3.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS live_artifact_configs (
      id                      TEXT PRIMARY KEY,
      artifact_id             TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
      -- Optional MCP connection (mcp_gateway_clients key)
      mcp_server_key          TEXT,
      refresh_tool            TEXT,
      refresh_args            TEXT,          -- JSON object
      -- Refresh cadence
      refresh_interval_seconds INTEGER NOT NULL DEFAULT 0,
      cache_ttl_seconds        INTEGER NOT NULL DEFAULT 30,
      -- Tracking
      last_refreshed_at        TEXT,
      refresh_count            INTEGER NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at               TEXT
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_live_artifact_configs_artifact
      ON live_artifact_configs(artifact_id)
  `).run();
}
