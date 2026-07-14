import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m177 — Upgrade Engine (Source configuration): `upgrade_source_config`, the operator-managed record of WHERE
 * this instance discovers releases.
 *
 * Until now the release SOURCE was environment-only (`GENEWEAVE_UPGRADE_REPO`, `GENEWEAVE_UPGRADE_TRUSTED_KEYS`,
 * …), so an operator had no in-app way to point the Upgrade Center at a repo and no persisted record of it.
 * This table holds that config so it can be set from the Upgrade Center UI (a platform-admin action) and read
 * by the `check` command — env vars remain a fallback for headless/bootstrap deploys.
 *
 * It is a PLATFORM-GLOBAL SINGLETON (one row, id = 'default'): a release source is a property of the
 * deployment, not of a tenant, so — unlike the realm-enabled `upgrade_family_policy` — it carries no realm /
 * owner_tenant_id columns and is never tenant-forkable.
 *
 * Secret hygiene: the `trusted_keys_pem` column holds PUBLIC signing keys (safe at rest); the private-repo
 * bearer token is NEVER stored here — only a `token_credential_id` REFERENCE into the encrypted credential
 * vault is kept, and the token itself is decrypted per check and never retained (mirrors the env path's
 * `buildUpgradeTokenProvider`).
 *
 * One new table, idempotent. Postgres via the regenerated schema.
 */
export function applyM177UpgradeSource(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_source_config (
       id TEXT PRIMARY KEY,                 -- always 'default' (platform-global singleton)
       repo TEXT NOT NULL,                  -- GitHub 'owner/repo' the signed release manifest is published on
       edition TEXT NOT NULL DEFAULT 'community', -- the edition this instance accepts (community | enterprise | …)
       asset_name TEXT NOT NULL DEFAULT 'manifest.json', -- the manifest asset's file name on the release
       trusted_keys_pem TEXT NOT NULL,      -- one or more PUBLIC Ed25519 keys (PEM bundle) — signature trust root
       api_base TEXT,                       -- GitHub API base override (GitHub Enterprise); NULL = public github.com
       token_credential_id TEXT,            -- vault credential id for a PRIVATE repo bearer token; NULL = public repo
       auto_check INTEGER NOT NULL DEFAULT 0, -- reserved: 1 = a scheduled background check may run (Phase 3)
       enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = configured but paused (check returns not_configured)
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_by TEXT                      -- user id of the platform admin who last saved it (audit)
     )`,
  );
}
