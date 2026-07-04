/**
 * Migration m55 — Step-up MFA schema (4.17)
 *
 * Adds the columns needed for TOTP-based step-up MFA on admin routes:
 *
 *  users table:
 *    - mfa_enabled INTEGER NOT NULL DEFAULT 0
 *        Set to 1 once the user completes /api/admin/mfa/setup/confirm.
 *    - mfa_totp_secret TEXT
 *        Base32-encoded TOTP secret (vault-encrypted when VAULT_KEY is set).
 *        NULL until the user initiates setup.
 *
 *  sessions table:
 *    - mfa_verified_at TEXT
 *        ISO timestamp of the most recent step-up MFA challenge for this
 *        session. NULL = not yet verified. Expires after 15 minutes
 *        (enforced in application code, not DB — avoids a column-update on
 *        every request).
 *
 * All ALTER TABLE steps are wrapped in safeExec so the migration is safe to
 * run on databases that already have these columns.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Swallow "duplicate column" errors — idempotent.
  }
}

export function applyM55StepUpMfa(db: BetterSqlite3.Database): void {
  // Users: MFA enrollment state + TOTP secret.
  safeExec(db, `ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE users ADD COLUMN mfa_totp_secret TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users(mfa_enabled)`);

  // Sessions: step-up MFA verification timestamp.
  safeExec(db, `ALTER TABLE sessions ADD COLUMN mfa_verified_at TEXT`);
}
