/**
 * Migration m59 — Durable live-agent stop signal (M6-2)
 *
 * Problem: stop signals for live-agent runs live in a process-local Map.
 * A restart or cross-process stop request loses the signal entirely.
 *
 * Solution:
 *   1. Add `stop_requested INTEGER NOT NULL DEFAULT 0` to `live_runs` so
 *      mesh-orchestrated runs can also carry a durable stop flag.
 *
 *   2. Create `api_live_runs` — a lightweight table for runs started via
 *      the `/api/live-agents/runs` REST API. These runs are user-scoped and
 *      have no mesh FK dependency, so a separate table avoids breaking the
 *      existing `live_runs(mesh_id)` NOT NULL FK constraint.
 *
 * Both additions are idempotent (ALTER TABLE IF NOT EXISTS / CREATE TABLE IF
 * NOT EXISTS). Safe to apply on a live database.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* column or table already exists — idempotent */ }
}

export function applyM59LiveRunsStopRequested(db: BetterSqlite3.Database): void {
  // Add stop_requested to mesh-orchestrated live_runs
  safe(db, `ALTER TABLE live_runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0`);

  // Standalone API-initiated run table (no mesh FK constraint)
  safe(db, `
    CREATE TABLE IF NOT EXISTS api_live_runs (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      tenant_id    TEXT,
      agent_id     TEXT,
      status       TEXT NOT NULL DEFAULT 'running',
      stop_requested INTEGER NOT NULL DEFAULT 0,
      config_json  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  safe(db, `CREATE INDEX IF NOT EXISTS idx_api_live_runs_user ON api_live_runs(user_id, status, created_at DESC)`);
}
