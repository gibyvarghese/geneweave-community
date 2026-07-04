/**
 * Migration m58 — Backfill vault encryption for existing credential rows (H-2 Phase 2)
 *
 * m49 added shadow columns; db-sqlite.ts now encrypts on write. This migration
 * backfills existing plaintext rows in the three tables that carry external
 * credentials so every row has credentials_encrypted = 1 after boot.
 *
 * Safe to run when VAULT_KEY is absent — the migration is skipped entirely and
 * plaintext rows remain (fail-open). Re-run whenever VAULT_KEY is later set.
 *
 * Idempotent: only rows with credentials_encrypted = 0 are touched.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { encryptCredential } from '../vault.js';

function tryEncrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return encryptCredential(value).encrypted; } catch { return null; }
}

export function applyM58BackfillCredentialEncryption(db: BetterSqlite3.Database): void {
  if (!process.env['VAULT_KEY']) return; // fail-open

  // ── search_providers ────────────────────────────────────────────────────────
  {
    type Row = { id: string; api_key: string | null };
    const rows = db.prepare(`SELECT id, api_key FROM search_providers WHERE credentials_encrypted = 0`).all() as Row[];
    const upd = db.prepare(`UPDATE search_providers SET api_key = NULL, api_key_enc = ?, credentials_encrypted = 1 WHERE id = ?`);
    for (const row of rows) {
      const enc = tryEncrypt(row.api_key);
      if (enc) upd.run(enc, row.id);
    }
  }

  // ── social_accounts ─────────────────────────────────────────────────────────
  {
    type Row = { id: string; api_key: string|null; api_secret: string|null; access_token: string|null; refresh_token: string|null };
    const rows = db.prepare(`SELECT id, api_key, api_secret, access_token, refresh_token FROM social_accounts WHERE credentials_encrypted = 0`).all() as Row[];
    const upd = db.prepare(`UPDATE social_accounts SET api_key = NULL, api_key_enc = ?, api_secret = NULL, api_secret_enc = ?, access_token = NULL, access_token_enc = ?, refresh_token = NULL, refresh_token_enc = ?, credentials_encrypted = 1 WHERE id = ?`);
    for (const row of rows) {
      const eKey    = tryEncrypt(row.api_key);
      const eSecret = tryEncrypt(row.api_secret);
      const eAccess = tryEncrypt(row.access_token);
      const eRefresh= tryEncrypt(row.refresh_token);
      if (eKey ?? eSecret ?? eAccess ?? eRefresh) {
        upd.run(eKey, eSecret, eAccess, eRefresh, row.id);
      }
    }
  }

  // ── enterprise_connectors ───────────────────────────────────────────────────
  {
    type Row = { id: string; access_token: string|null; refresh_token: string|null; auth_config: string|null };
    const rows = db.prepare(`SELECT id, access_token, refresh_token, auth_config FROM enterprise_connectors WHERE credentials_encrypted = 0`).all() as Row[];
    const upd = db.prepare(`UPDATE enterprise_connectors SET access_token = NULL, access_token_enc = ?, refresh_token = NULL, refresh_token_enc = ?, auth_config = NULL, auth_config_enc = ?, credentials_encrypted = 1 WHERE id = ?`);
    for (const row of rows) {
      const eAccess  = tryEncrypt(row.access_token);
      const eRefresh = tryEncrypt(row.refresh_token);
      const eAuth    = tryEncrypt(row.auth_config);
      if (eAccess ?? eRefresh ?? eAuth) {
        upd.run(eAccess, eRefresh, eAuth, row.id);
      }
    }
  }
}
