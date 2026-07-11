import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m163 — Upgrade-run persistence (geneWeave Upgrade Engine, L4 foundations).
 *
 * The realm substrate already classifies a shipped default against an operator's edits (in_sync /
 * customized / stale / diverged) and reconciles the safe moves at seed time. What it did not yet do is
 * *record* those outcomes durably so an operator can see, after a release lands, exactly what was adopted
 * automatically, what was kept because they had customised it, and what needs their attention — and so
 * later steps (the review queue, propagation) have rows to act on.
 *
 * This adds two tables:
 *   • `upgrade_runs`    — one row per reconcile/preview/apply pass: mode, status, version span, a summary
 *                         count by disposition, and timing.
 *   • `upgrade_details` — one row per (family, logical_key) the pass touched: its disposition, a priority
 *                         band (P1 highest — guardrails/auth/collisions … P5 pricing/labels), the three
 *                         content hashes for the diff/merge workbench, and a resolution slot filled in
 *                         when a human (or an automation rule) later decides it.
 *
 * The `schema_migrations` ledger itself is created and maintained by the migration runner (see
 * `helpers.ts`), not here, so it exists before any batch — including this one — runs.
 *
 * Relabel-free: two new tables, zero data movement, fully idempotent (CREATE TABLE IF NOT EXISTS +
 * guarded index creation). Postgres gets the identical tables via the regenerated schema.
 */
export function applyM163UpgradeLedger(db: BetterSqlite3.Database): void {
  // One row per reconcile/preview/apply pass.
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_runs (
       id TEXT PRIMARY KEY,
       mode TEXT NOT NULL,                         -- 'seed_reconcile' | 'preview' | 'apply'
       status TEXT NOT NULL,                       -- 'running' | 'succeeded' | 'succeeded_with_pending' | 'failed' | 'rolled_back'
       from_version TEXT,
       to_version TEXT,
       dialect TEXT,
       summary_json TEXT NOT NULL DEFAULT '{}',    -- counts keyed by disposition
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       finished_at TEXT
     )`,
  );

  // One row per (family, logical_key) a pass touched.
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_details (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       family TEXT NOT NULL,
       logical_key TEXT NOT NULL,
       layer TEXT NOT NULL DEFAULT 'L4',
       disposition TEXT NOT NULL,                  -- ReconcileState ∪ {adopted, published, auto_merged, conflict, deferred}
       priority TEXT NOT NULL DEFAULT 'P3',        -- 'P1' (highest) .. 'P5'
       base_hash TEXT,
       local_hash TEXT,
       remote_hash TEXT,
       note TEXT,
       resolution TEXT,                            -- null until a human/automation resolves it
       resolved_at TEXT,
       resolved_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       FOREIGN KEY (run_id) REFERENCES upgrade_runs(id)
     )`,
  );

  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_upgrade_details_run ON upgrade_details(run_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_upgrade_details_family_key ON upgrade_details(family, logical_key)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_upgrade_details_priority ON upgrade_details(priority)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_upgrade_details_disposition ON upgrade_details(disposition)`);
  // Propagation keys resolutions by (family, logical_key, remote_hash) — index it for the lookup.
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_upgrade_details_propagation ON upgrade_details(family, logical_key, remote_hash)`);
}
