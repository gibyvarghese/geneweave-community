import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * M26 — Workflow Phase W5: Governance and Operations
 *
 * 1. workflow_runs       — adds priority and cost_breakdown columns.
 * 2. workflow_run_queue  — persisted priority queue for concurrency-buffered runs.
 * 3. workflow_rate_limits— per-workflow token-bucket state for rate limiting.
 */
export function applyM26WorkflowW5(db: BetterSqlite3.Database): void {
  // 1. Governance columns on workflow_runs
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN cost_breakdown TEXT');  // JSON object
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)');

  // 2. Persisted run queue — one row per buffered run (status='pending' in workflow_runs)
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_run_queue (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      input       TEXT NOT NULL DEFAULT '{}',
      priority    INTEGER NOT NULL DEFAULT 0,
      queued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      opts        TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_wf ON workflow_run_queue(workflow_id, priority DESC, queued_at ASC)');

  // 3. Token-bucket rate-limit state — one row per workflow definition
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_rate_limits (
      workflow_id   TEXT PRIMARY KEY,
      tokens        REAL NOT NULL,
      last_refill_ms INTEGER NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
