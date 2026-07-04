import type BetterSqlite3 from 'better-sqlite3';

/**
 * m91 — Client Phase 0: run/stream configuration.
 *
 * A single-row `run_stream_config` moves the run-event streaming tuning out of
 * hardcoded constants and into the database (no code change):
 *   - `heartbeat_ms`            — SSE keepalive interval (server, routes/me.ts).
 *   - `max_reconnects`/`backoff_ms` — client auto-reconnect budget + schedule
 *     (served via GET /api/me/runs/config, consumed by @weaveintel/client).
 *   - `stall_timeout_ms`        — tear-down window for a silent stream.
 *   - `throttle_ms`             — client UI-update throttle.
 *   - `journal_retention_hours`/`journal_max_events` — `user_run_events` pruning
 *     (the journal previously grew unbounded).
 *   - `resume_window_seconds`   — refresh-proof resume window.
 *
 * Seeded from `RUN_STREAM_CONFIG_DEFAULTS` in @weaveintel/core so the DB row and
 * the client/server fallbacks share one definition.
 */
export function applyM91RunStreamConfig(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_stream_config (
      id TEXT PRIMARY KEY DEFAULT 'global',
      enabled INTEGER NOT NULL DEFAULT 1,
      heartbeat_ms INTEGER NOT NULL DEFAULT 15000,
      max_reconnects INTEGER NOT NULL DEFAULT 8,
      backoff_ms TEXT NOT NULL DEFAULT '[250,500,1000,2000,4000,8000,16000,30000]',
      stall_timeout_ms INTEGER NOT NULL DEFAULT 60000,
      throttle_ms INTEGER NOT NULL DEFAULT 50,
      journal_retention_hours INTEGER NOT NULL DEFAULT 24,
      journal_max_events INTEGER NOT NULL DEFAULT 2000,
      resume_window_seconds INTEGER NOT NULL DEFAULT 900,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO run_stream_config
       (id, enabled, heartbeat_ms, max_reconnects, backoff_ms, stall_timeout_ms, throttle_ms, journal_retention_hours, journal_max_events, resume_window_seconds)
     VALUES ('global', 1, 15000, 8, ?, 60000, 50, 24, 2000, 900)`,
  ).run(JSON.stringify([250, 500, 1000, 2000, 4000, 8000, 16000, 30000]));
}
