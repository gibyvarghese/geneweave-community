import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m174 — Upgrade Engine: `upgrade_code_baseline`, the stored per-file source baseline (L2 identity) of the
 * installed application code.
 *
 * The L2 code layer answers "did the operator edit this vendor file, and did the release change it?" — a
 * three-way comparison against BASE (what shipped). For a non-git install, BASE is this stored baseline: the
 * `source_baselines` manifest (path → SRI) captured at install/upgrade time, plus its digest. A `code status`
 * scan hashes the live tree and compares it here; an upgrade compares it against the release's target baseline.
 *
 * One fixed row (`id = 'singleton'`) holding the manifest as JSON — the whole map is read at once to classify,
 * so a single blob is simpler than a per-path table and bounded by the tree size. One new table, idempotent.
 * Postgres via the regenerated schema.
 */
export function applyM174UpgradeCodeBaseline(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_code_baseline (
       id TEXT PRIMARY KEY,                  -- always the literal 'singleton'
       manifest_json TEXT,                   -- the source_baselines manifest (path → SRI) as JSON; NULL until captured
       digest TEXT,                          -- the manifest's fileManifestDigest
       captured_at TEXT                      -- when the baseline was taken (text 'YYYY-MM-DD HH:MM:SS')
     )`,
  );
  // Seed the one row EMPTY (no baseline yet). INSERT OR IGNORE so re-running never clobbers a captured baseline.
  safeExec(db, `INSERT OR IGNORE INTO upgrade_code_baseline (id, manifest_json, digest, captured_at) VALUES ('singleton', NULL, NULL, NULL)`);
}
