import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m170 — Upgrade Engine: `upgrade_lock`, a single-row advisory MUTEX so only one upgrade operation runs at a
 * time on an instance.
 *
 * geneWeave has no other cross-process lock primitive (no `pg_advisory_lock`, no lock file), and a preview or
 * apply that raced a second apply could read/write half-applied state. This table is the portable lock: one
 * fixed row (`id = 'singleton'`) whose `holder` is either NULL (free) or the label of whoever holds it, plus
 * an `acquired_at` used to break a STALE lock left by a crashed holder.
 *
 * Acquisition is a compare-and-set `UPDATE … WHERE holder IS NULL OR acquired_at <= <stale-cutoff>` followed
 * by a confirming `SELECT` (see `upgrade-lock-store.ts`): both engines serialise the guarded UPDATE on the
 * one row, so exactly one caller wins. One new table, one seeded row, idempotent. Postgres via the
 * regenerated schema.
 */
export function applyM170UpgradeLock(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_lock (
       id TEXT PRIMARY KEY,                  -- always the literal 'singleton' (one lock per instance)
       holder TEXT,                          -- who holds it (a run label), NULL = free
       acquired_at TEXT                      -- when it was taken (text 'YYYY-MM-DD HH:MM:SS'); NULL when free
     )`,
  );
  // Seed the one lock row FREE. INSERT OR IGNORE so re-running the migration never clobbers a held lock.
  safeExec(db, `INSERT OR IGNORE INTO upgrade_lock (id, holder, acquired_at) VALUES ('singleton', NULL, NULL)`);
}
