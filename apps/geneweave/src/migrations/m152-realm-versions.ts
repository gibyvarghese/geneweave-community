import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m152 — Realm version log + drift baseline (Tenancy Realm Phase 2).
 *
 * Phase 1 (m151) classified prompts as global-realm originals with a content_hash. Phase 2 adds the
 * machinery to ship UPDATES to those built-in defaults without clobbering operator edits — the "config
 * file in /etc on package upgrade" problem. Two pieces:
 *
 *  1. `realm_versions` — an append-only log of every version of a default the product has published.
 *     It is the drift BASELINE, kept separate from the live row so an operator's in-place edit never
 *     erases it. (Shape matches @weaveintel/realm's realmVersionsDdl.)
 *  2. Backfill `origin_hash = content_hash` on existing global prompts, so every current row starts
 *     "in sync" (Base = Local). Going forward: origin_hash = Base (last synced), content_hash = Local
 *     (operator edits), realm_versions latest = Remote (current release default, maintained by seed).
 *
 * Zero data movement — a relabel + a new empty log. Idempotent (guarded). Postgres gets the table via
 * the regenerated schema + the same backfill in db-postgres/seed.ts.
 */
export function applyM152RealmVersions(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE TABLE IF NOT EXISTS realm_versions (
    id            TEXT PRIMARY KEY,
    family        TEXT NOT NULL,
    logical_key   TEXT NOT NULL,
    version       INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    payload       TEXT NOT NULL,
    published_by  TEXT,
    note          TEXT,
    published_at  TEXT NOT NULL
  )`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_realm_versions_key_version ON realm_versions(family, logical_key, version)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_realm_versions_family_key ON realm_versions(family, logical_key)`);

  // Establish the drift baseline for existing global rows: Base := current content (they start in sync).
  for (const table of ['prompts', 'prompt_fragments']) {
    safeExec(db, `UPDATE ${table} SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  }
}
