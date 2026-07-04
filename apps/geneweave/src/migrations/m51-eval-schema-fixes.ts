/**
 * Migration m51 — Eval schema fixes (L-15 + M-19)
 *
 * L-15: `prompt_eval_runs.status` defaulted to 'completed' in all prior
 * migrations. A newly-inserted eval run is pending execution, not complete —
 * this default caused the dashboard to display unsettled runs as finished and
 * made the `status = 'pending'` filter useless for detecting stuck jobs.
 *
 * M-19: `eval_results` captures a denormalised settings snapshot (system_prompt,
 * timezone, enabled_tools, etc.) but has no timestamp indicating when that
 * snapshot was taken. Without `settings_snapshot_at` there is no way to know
 * whether the snapshot reflects the current config or an older version, making
 * reproducibility analysis unreliable.
 *
 * Schema changes:
 *   1. `ALTER TABLE prompt_eval_runs ALTER COLUMN status` cannot change a
 *      DEFAULT retroactively in SQLite. Instead we leave the column unchanged
 *      for existing rows and let the application + db-schema.ts default handle
 *      new rows. The `db-schema.ts` CREATE TABLE statement now uses 'pending'.
 *
 *   2. `ALTER TABLE eval_results ADD COLUMN settings_snapshot_at TEXT` —
 *      existing rows will have NULL (unknown snapshot time), which is honest.
 *      New rows written after this migration will populate the column.
 *
 * Both changes are idempotent (ADD COLUMN IF NOT EXISTS via try/catch).
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent */ }
}

export function applyM51EvalSchemaFixes(db: BetterSqlite3.Database): void {

  // M-19: Add settings_snapshot_at to eval_results.
  // Existing rows default to NULL (snapshot time unknown — honest rather than
  // fabricating a timestamp). New rows should be written with
  // settings_snapshot_at = datetime('now') at insert time.
  safe(db, `ALTER TABLE eval_results ADD COLUMN settings_snapshot_at TEXT`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_eval_results_snapshot ON eval_results(settings_snapshot_at)`);

  // L-15: SQLite does not support ALTER COLUMN to change a DEFAULT value.
  // New tables created by db-schema.ts already use DEFAULT 'pending'.
  // For existing databases we leave the default as-is for the column and
  // instead rely on the application to always supply an explicit status value
  // at INSERT time. The index below helps the status-filter query that the
  // job-monitor uses to find stuck runs.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON prompt_eval_runs(status, created_at DESC)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_prompt_opt_runs_status ON prompt_optimization_runs(status, created_at DESC)`);
}
