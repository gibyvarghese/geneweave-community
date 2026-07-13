import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m172 — Upgrade Engine: `upgrade_runs.snapshot_ref`, the path of the pre-upgrade snapshot an apply RETAINS
 * so it can be rolled back later.
 *
 * Phase-3 apply always snapshots before it mutates and, on an in-flight failure, restores + discards it. But
 * a run that *succeeds* and only later proves bad — a broken build, a failed post-apply check — must still be
 * reversible on demand (`rollback --run <id>`). To make that possible the successful apply keeps its snapshot
 * and records its path here; the manual rollback reads it and restores. Retention is bounded (the newest
 * successful apply keeps its snapshot; older ones are discarded), so at most one snapshot is held.
 *
 * One nullable column, zero data movement, idempotent (ADD COLUMN throws if it exists → skipped). Postgres
 * via the regenerated schema.
 */
export function applyM172UpgradeSnapshotRef(db: BetterSqlite3.Database): void {
  // ADD COLUMN throws on an existing column; safeExec swallows that (lenient boot) so re-running is a no-op.
  safeExec(db, `ALTER TABLE upgrade_runs ADD COLUMN snapshot_ref TEXT`);
}
