import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m171 — Upgrade Engine: `upgrade_maintenance`, a single-row flag the apply orchestrator raises while it is
 * mutating the schema and content (the L1–L3 window) so the instance can shed user traffic during the risky
 * part of an upgrade.
 *
 * This is the mechanism, not the enforcement point: apply sets `active = 1` (with a reason + timestamp)
 * before it snapshots and runs migrations, and clears it in a `finally`. An edge/middleware layer can read
 * it (`isMaintenanceActive`) to return 503s while it's up; the flag also lands in the run's audit summary.
 *
 * One fixed row (`id = 'singleton'`), seeded INACTIVE. One new table, idempotent. Postgres via the
 * regenerated schema.
 */
export function applyM171UpgradeMaintenance(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_maintenance (
       id TEXT PRIMARY KEY,                  -- always the literal 'singleton'
       active INTEGER NOT NULL DEFAULT 0,    -- 1 while an upgrade is mutating (L1–L3)
       reason TEXT,                          -- why maintenance is on (e.g. 'applying release 2.0.0')
       since TEXT                            -- when it was raised (text 'YYYY-MM-DD HH:MM:SS'); NULL when off
     )`,
  );
  // Seed the one row INACTIVE. INSERT OR IGNORE so re-running never clears an active maintenance window.
  safeExec(db, `INSERT OR IGNORE INTO upgrade_maintenance (id, active, reason, since) VALUES ('singleton', 0, NULL, NULL)`);
}
