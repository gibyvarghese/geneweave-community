/**
 * Migration m44 — Auth hardening: email verification + admin invitations
 *
 * 1. users.email_verified   — 0 until the registration email link is clicked.
 *    Existing rows default to 1 (grandfathered) so live DBs keep working.
 * 2. users.email_verified_at — ISO8601 timestamp of verification.
 * 3. email_verifications     — one-time SHA-256-hashed tokens (32 raw bytes).
 * 4. user_invitations        — admin-issued, HMAC-SHA256-signed single-use tokens.
 *    Required for tenant_admin / platform_admin persona assignment.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent */ }
}

export function applyM44AuthHardening(db: BetterSqlite3.Database): void {
  // ── 1. Email-verified columns on users ──────────────────────────────────────
  // New users start unverified (0); existing rows are grandfathered as verified.
  safe(db, 'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE users ADD COLUMN email_verified_at TEXT');

  // Grandfather existing users so existing deployments do not lock everyone out.
  try {
    db.prepare(
      "UPDATE users SET email_verified = 1, email_verified_at = datetime('now') WHERE email_verified = 0",
    ).run();
  } catch { /* ignore — column may not exist yet on a fresh DB */ }

  // ── 2. email_verifications ───────────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS email_verifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id)');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_email_verif_expires ON email_verifications(expires_at)');

  // ── 3. user_invitations ──────────────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS user_invitations (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    persona     TEXT NOT NULL DEFAULT 'tenant_user',
    token_hash  TEXT NOT NULL UNIQUE,
    invited_by  TEXT NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    used_by     TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_invitation_email ON user_invitations(email)');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_invitation_expires ON user_invitations(expires_at)');
}
