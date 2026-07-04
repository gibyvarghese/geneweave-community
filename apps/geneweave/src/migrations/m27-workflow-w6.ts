import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * M27 — Workflow Phase W6: Observability and Developer Experience
 *
 * 1. workflow_spans — structured step spans (OTel-compatible) persisted per run.
 */
export function applyM27WorkflowW6(db: BetterSqlite3.Database): void {
  // 1. Step spans table
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_spans (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL,
      workflow_id  TEXT NOT NULL,
      step_id      TEXT NOT NULL,
      handler_kind TEXT NOT NULL,
      handler_key  TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL,
      status       TEXT NOT NULL CHECK(status IN ('completed','failed','skipped','paused')),
      retry_count  INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL NOT NULL DEFAULT 0,
      error        TEXT,
      attributes   TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_spans_run ON workflow_spans(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_spans_wf ON workflow_spans(workflow_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_spans_step ON workflow_spans(run_id, step_id)');
}
