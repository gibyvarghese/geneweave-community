import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * M25 — Workflow Phase W4: Durability and Recovery
 *
 * 1. workflow_runs      — adds parent_run_id and child_run_ids for cascaded cancellation.
 * 2. workflow_events    — immutable append-only audit log (one row per state transition).
 * 3. workflow_sleeps    — durable sleep records; scheduler polls wakeAt for auto-resume.
 * 4. workflow_step_locks — exactly-once step execution; locked → done per step per run.
 */
export function applyM25WorkflowW4(db: BetterSqlite3.Database): void {
  // 1. Parent/child run linkage on workflow_runs
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT');
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN child_run_ids TEXT');  // JSON array
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent ON workflow_runs(parent_run_id)');

  // 2. Immutable audit event log
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_events (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      type        TEXT NOT NULL,
      step_id     TEXT,
      timestamp   TEXT NOT NULL,
      trace_id    TEXT,
      tenant_id   TEXT,
      caused_by   TEXT,
      data        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON workflow_events(type)');

  // 3. Durable sleep records — one per paused run awaiting timed auto-resume
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_sleeps (
      run_id     TEXT PRIMARY KEY,
      wake_at    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_sleeps_wake ON workflow_sleeps(wake_at)');

  // 4. Step lock store — exactly-once delivery guard
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_step_locks (
      run_id     TEXT NOT NULL,
      step_id    TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'locked',
      locked_at  TEXT NOT NULL,
      done_at    TEXT,
      output     TEXT,
      PRIMARY KEY (run_id, step_id)
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_step_locks_run ON workflow_step_locks(run_id)');
}
