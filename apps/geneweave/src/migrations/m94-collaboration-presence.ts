import type BetterSqlite3 from 'better-sqlite3';

/**
 * m94 — Collaboration Phase 1: presence ("who else is watching this run").
 *
 * Two tables:
 *
 * 1. `run_presence` — the **current-state** store for presence. One row per
 *    (run, participant); a heartbeat UPSERTs it and slides `expires_at`; a TTL
 *    sweep DELETEs rows whose `expires_at` has passed. This is deliberately NOT
 *    an append-only log — presence is high-churn and disposable (it only ever
 *    means "right now"), so it must never go into `user_run_events`.
 *      - `peer_type` distinguishes humans from AI agents (agents are first-class
 *        presence peers — the server shows the agent as present while a run runs).
 *      - identity (`user_id`, `display_name`) is server-derived; never client PII.
 *      - `UNIQUE(run_id, user_id)` — one presence row per participant per run.
 *
 * 2. `collaboration_config` — a single-row config (mirrors `run_stream_config`)
 *    so the heartbeat/TTL/sweep cadence is DB-driven, not hardcoded. Defaults
 *    follow the Yjs-canonical 15s heartbeat / 30s TTL (TTL = 2× heartbeat, so a
 *    single missed heartbeat never drops a peer — no flicker), 10s sweep.
 */
export function applyM94CollaborationPresence(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_presence (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id       TEXT,
      user_id         TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      presence        TEXT NOT NULL DEFAULT 'online',
      peer_type       TEXT NOT NULL DEFAULT 'human',
      color           TEXT,
      cursor_json     TEXT,
      last_heartbeat_at INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, user_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_presence_run     ON run_presence(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_presence_expires ON run_presence(expires_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_config (
      id TEXT PRIMARY KEY DEFAULT 'global',
      enabled INTEGER NOT NULL DEFAULT 1,
      presence_heartbeat_ms INTEGER NOT NULL DEFAULT 15000,
      presence_ttl_ms INTEGER NOT NULL DEFAULT 30000,
      presence_sweep_ms INTEGER NOT NULL DEFAULT 10000,
      max_participants_per_run INTEGER NOT NULL DEFAULT 50,
      show_agent_presence INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO collaboration_config
       (id, enabled, presence_heartbeat_ms, presence_ttl_ms, presence_sweep_ms, max_participants_per_run, show_agent_presence)
     VALUES ('global', 1, 15000, 30000, 10000, 50, 1)`,
  ).run();
}
