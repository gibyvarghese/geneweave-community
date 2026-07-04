import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration m93 — run-scope HITL approvals.
 *
 * The m64 `hitl_interrupt_requests` table is chat-scoped and had no writer. The
 * run path (/api/me/runs) now writes pending approvals to it so a paused run's
 * approval survives a restart and is queryable. Adds a `run_id` column + index.
 */
function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent — column/index may already exist */ }
}

export function applyM93HitlRunScope(db: BetterSqlite3.Database): void {
  safe(db, 'ALTER TABLE hitl_interrupt_requests ADD COLUMN run_id TEXT');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_hitl_run_status ON hitl_interrupt_requests(run_id, status)');
}
