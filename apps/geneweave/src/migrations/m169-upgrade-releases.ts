import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m169 — Upgrade Engine: `upgrade_releases`, the record of every release manifest this instance has
 * checked.
 *
 * The `check` command polls the release source, verifies the manifest, and writes one row here per check:
 * what release it saw, whether it was accepted (a trusted, current-or-newer manifest) or rejected (and
 * why — bad signature, expired, downgrade, wrong edition, …), and the manifest itself for an accepted one.
 *
 * Two jobs: an audit trail an operator can read, and the ANTI-ROLLBACK FLOOR — the highest version we have
 * ever *accepted*. A later check compares against `max(installed, this floor)`, so a replayed old but
 * validly-signed manifest can never talk an instance into a downgrade.
 *
 * One new table, zero data movement, idempotent. Postgres via regenerated schema.
 */
export function applyM169UpgradeReleases(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_releases (
       id TEXT PRIMARY KEY,
       name TEXT,
       version TEXT NOT NULL,
       edition TEXT,
       channel TEXT,
       published_at TEXT,
       expires_at TEXT,
       key_fingerprint TEXT,                       -- the signing key's fingerprint (accepted or not)
       outcome TEXT NOT NULL,                      -- 'up_to_date' | 'update_available' | 'rejected'
       reject_reason TEXT,                         -- distinct reason when outcome = 'rejected'
       accepted INTEGER NOT NULL DEFAULT 0,        -- 1 iff the manifest passed every check (raises the floor)
       manifest_json TEXT,                         -- the manifest, kept for an accepted release
       checked_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  // The anti-rollback floor query is `SELECT max(version) WHERE accepted = 1`; index accepted+version.
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_releases_accepted ON upgrade_releases(accepted, version)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_releases_checked ON upgrade_releases(checked_at)`);
}
