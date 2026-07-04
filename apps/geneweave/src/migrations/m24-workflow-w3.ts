import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * M24 — Workflow Phase W3: State and Data Layer
 *
 * 1. workflow_runs   — adds trace_id and tenant_id for context propagation.
 * 2. workflow_payloads — new table for large payload offload.  Step outputs
 *    exceeding policy.maxInlineBytes are stored here; state.variables holds
 *    only a lightweight reference object { __payloadRef: key }.
 */
export function applyM24WorkflowW3(db: BetterSqlite3.Database): void {
  // 1. Context propagation columns on workflow_runs
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN trace_id TEXT');
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN tenant_id TEXT');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_trace ON workflow_runs(trace_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant ON workflow_runs(tenant_id)');

  // 2. Large payload offload store
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_payloads (
      key        TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      step_id    TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_workflow_payloads_run ON workflow_payloads(run_id)');
}
