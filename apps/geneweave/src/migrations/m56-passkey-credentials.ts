/**
 * Migration m56 — FIDO2/WebAuthn passkey credential storage (4.1)
 *
 * Creates two tables:
 *
 *  passkey_credentials — one row per registered WebAuthn credential.
 *    A single user may have multiple passkeys (laptop TouchID, phone,
 *    hardware key). Each credential has a unique credential_id (base64url)
 *    issued by the authenticator, a COSE-encoded public key, and a
 *    signature counter for replay-attack detection.
 *
 *  webauthn_challenges — short-lived (5-minute TTL) challenges issued
 *    during both registration and authentication flows. Consumed on first
 *    use so they cannot be replayed.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent */ }
}

export function applyM56PasskeyCredentials(db: BetterSqlite3.Database): void {
  // WebAuthn registered credentials (one per authenticator per user).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key_cose TEXT NOT NULL,
      aaguid TEXT NOT NULL DEFAULT '',
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_passkey_cred_user ON passkey_credentials(user_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_passkey_cred_id ON passkey_credentials(credential_id)`);

  // Short-lived WebAuthn challenges.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      challenge TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('registration', 'authentication')),
      used INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges(user_id, type)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at)`);
}
