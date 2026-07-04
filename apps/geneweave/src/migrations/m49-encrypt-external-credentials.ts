/**
 * Migration m49 — Encrypt external credential fields at rest (H-2)
 *
 * Problem: `search_providers.api_key`, `social_accounts.api_key / api_secret /
 * access_token / refresh_token`, and `enterprise_connectors.access_token /
 * refresh_token / auth_config` are stored as plaintext TEXT columns. Any
 * process with read access to the SQLite file (backup, core dump, log export)
 * can extract live third-party credentials.
 *
 * Solution (schema layer):
 *   1. Add `credentials_encrypted INTEGER NOT NULL DEFAULT 0` to each table.
 *      A value of 1 signals that the companion `_enc` columns contain
 *      AES-256-GCM ciphertext (base64url-encoded) produced by the tenant key
 *      manager (DEK wrapping), and that the plaintext columns have been nulled.
 *      A value of 0 means the row was written before this migration and still
 *      carries plaintext — the adapter must handle both states during the
 *      warm migration window.
 *
 *   2. Add `*_enc TEXT` shadow columns for every sensitive field. These store
 *      the encrypted ciphertext. The plaintext columns remain so that rows
 *      written before Phase 2 of the credential migration are still readable.
 *
 * Adapter layer (db-sqlite.ts) responsibilities (H-2 TODO — wire after m49):
 *   • On INSERT/UPDATE: encrypt each sensitive field with the tenant DEK,
 *     write ciphertext to `*_enc`, set the plaintext column to NULL, set
 *     `credentials_encrypted = 1`.
 *   • On SELECT: if `credentials_encrypted = 1`, decrypt `*_enc` columns;
 *     if `credentials_encrypted = 0`, return plaintext columns as-is and
 *     schedule a background re-encryption job.
 *
 * This migration is safe to run on a live database (ALTER TABLE IF NOT EXISTS /
 * ADD COLUMN IF NOT EXISTS are idempotent under better-sqlite3's safeExec).
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent — column/table already exists */ }
}

export function applyM49EncryptExternalCredentials(db: BetterSqlite3.Database): void {

  // ── search_providers ──────────────────────────────────────────────────────
  // Sensitive field: api_key (provider API credential — full plaintext access
  // to the connected search engine account if leaked).
  safe(db, `ALTER TABLE search_providers ADD COLUMN credentials_encrypted INTEGER NOT NULL DEFAULT 0`);
  safe(db, `ALTER TABLE search_providers ADD COLUMN api_key_enc TEXT`);

  // Index to allow efficient "find unencrypted rows" sweep during warm migration.
  safe(db, `CREATE INDEX IF NOT EXISTS idx_search_providers_enc_pending ON search_providers(credentials_encrypted) WHERE credentials_encrypted = 0`);

  // ── social_accounts ───────────────────────────────────────────────────────
  // Sensitive fields: api_key, api_secret, access_token, refresh_token.
  // All four provide full OAuth/API access to the connected social platform account.
  safe(db, `ALTER TABLE social_accounts ADD COLUMN credentials_encrypted INTEGER NOT NULL DEFAULT 0`);
  safe(db, `ALTER TABLE social_accounts ADD COLUMN api_key_enc     TEXT`);
  safe(db, `ALTER TABLE social_accounts ADD COLUMN api_secret_enc  TEXT`);
  safe(db, `ALTER TABLE social_accounts ADD COLUMN access_token_enc  TEXT`);
  safe(db, `ALTER TABLE social_accounts ADD COLUMN refresh_token_enc TEXT`);

  safe(db, `CREATE INDEX IF NOT EXISTS idx_social_accounts_enc_pending ON social_accounts(credentials_encrypted) WHERE credentials_encrypted = 0`);

  // ── enterprise_connectors ─────────────────────────────────────────────────
  // Sensitive fields: access_token, refresh_token, auth_config.
  // auth_config is a freeform JSON blob that often contains client_id,
  // client_secret, service-account keys, or mTLS certificates.
  safe(db, `ALTER TABLE enterprise_connectors ADD COLUMN credentials_encrypted INTEGER NOT NULL DEFAULT 0`);
  safe(db, `ALTER TABLE enterprise_connectors ADD COLUMN access_token_enc  TEXT`);
  safe(db, `ALTER TABLE enterprise_connectors ADD COLUMN refresh_token_enc TEXT`);
  safe(db, `ALTER TABLE enterprise_connectors ADD COLUMN auth_config_enc   TEXT`);

  safe(db, `CREATE INDEX IF NOT EXISTS idx_enterprise_connectors_enc_pending ON enterprise_connectors(credentials_encrypted) WHERE credentials_encrypted = 0`);
}
