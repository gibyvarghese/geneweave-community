import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m175 — Upgrade Engine (Automation + propagation): the two managed-config tables behind review-queue
 * automation, plus the `resolution_source` provenance column on `upgrade_details`.
 *
 * Both new tables are REALM-ENABLED (registered in realm-families.ts), so a change to a resolution rule or
 * a family's auto-adopt policy flows through the SAME propose → review → promote governance the config
 * catalog already uses (realm_proposals, m160) — no bespoke approval path. They therefore carry the standard
 * realm columns (realm/owner/logical_key/origin/content_hash/track/share) + the deprecation lifecycle columns,
 * exactly like every other realm family. Rows are created empty; the store stamps content_hash/logical_key/
 * origin_hash on insert and seed-reconcile's ensureFamilyBaselines self-heals any that predate a baseline.
 *
 *  1. `upgrade_resolution_rules` — ordered automation rules over the review queue. A rule matches an
 *     unresolved `upgrade_details` item by family / priority / disposition (each a JSON array, absent = any)
 *     and carries an action (keep | adopt | defer | tag). Applied first-match-wins by `seq`. A hard guardrail
 *     (in the engine, not the schema) refuses to auto-resolve a P1 — rules can only tag it.
 *
 *  2. `upgrade_family_policy` — one row per realm family overriding its auto-adopt policy (always | patch_only
 *     | never) at seed-reconcile time. Empty by default → the frozen AUTO_ADOPT_POLICY constant still applies,
 *     so a fresh install behaves exactly as before; a row overrides the constant for its family.
 *
 *  3. `upgrade_details.resolution_source` — provenance of a resolution: NULL = interactive (a human in the
 *     Upgrade Center), 'automation' = a resolution rule, 'imported' = a signed resolution bundle from another
 *     instance. Lets the audit distinguish who/what closed each item.
 *
 * Dual-engine: Postgres gets the same tables + column via the regenerated POSTGRES_FULL_SCHEMA. Idempotent
 * (CREATE TABLE IF NOT EXISTS; ADD COLUMN throws-and-is-skipped when present).
 */

/** Semantic (content-hash) fields of a resolution rule — identity (`key`/`name`) and `enabled` excluded. */
export const RESOLUTION_RULE_SEMANTIC_COLS = [
  'description', 'seq', 'match_families', 'match_priorities', 'match_dispositions', 'action', 'tag',
] as const;

/** Semantic (content-hash) fields of a family policy — identity (`target_family`) and `enabled` excluded. */
export const FAMILY_POLICY_SEMANTIC_COLS = ['policy'] as const;

/** The standard realm columns every realm-enabled table carries (mirrors m151/m157). */
const REALM_COLUMNS = `
  realm TEXT NOT NULL DEFAULT 'global',
  owner_tenant_id TEXT,
  logical_key TEXT,
  origin_id TEXT,
  origin_hash TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  track_mode TEXT NOT NULL DEFAULT 'pin',
  share_mode TEXT NOT NULL DEFAULT 'private',
  deprecated_at TEXT,
  deprecation_note TEXT,
  superseded_by_id TEXT`;

export function applyM175UpgradeAutomation(db: BetterSqlite3.Database): void {
  // ── 1. Resolution rules ──────────────────────────────────────────────────────────────────────────
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_resolution_rules (
       id TEXT PRIMARY KEY,
       key TEXT NOT NULL,                     -- stable rule name (the logical key of a global + its forks)
       name TEXT NOT NULL,                    -- display name
       description TEXT,
       seq INTEGER NOT NULL DEFAULT 100,      -- evaluation order; ascending, first match wins
       match_families TEXT,                   -- JSON array of family strings; NULL/empty = any family
       match_priorities TEXT,                 -- JSON array of 'P1'..'P5'; NULL/empty = any priority
       match_dispositions TEXT,               -- JSON array of dispositions; NULL/empty = any disposition
       action TEXT NOT NULL DEFAULT 'tag',    -- 'keep' | 'adopt' | 'defer' | 'tag'
       tag TEXT,                              -- annotation label for the 'tag' action (also audited on the item)
       enabled INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),${REALM_COLUMNS}
     )`,
  );
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_upgrade_resolution_rules_logical_owner ON upgrade_resolution_rules(logical_key, COALESCE(owner_tenant_id, ''))`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_resolution_rules_seq ON upgrade_resolution_rules(enabled, seq)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_resolution_rules_deprecated ON upgrade_resolution_rules(deprecated_at)`);

  // ── 2. Per-family auto-adopt policy ──────────────────────────────────────────────────────────────
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_family_policy (
       id TEXT PRIMARY KEY,
       target_family TEXT NOT NULL,           -- the realm family this row configures (also its logical key)
       policy TEXT NOT NULL DEFAULT 'patch_only',  -- 'always' | 'patch_only' | 'never'
       note TEXT,
       enabled INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),${REALM_COLUMNS}
     )`,
  );
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_upgrade_family_policy_logical_owner ON upgrade_family_policy(logical_key, COALESCE(owner_tenant_id, ''))`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_family_policy_deprecated ON upgrade_family_policy(deprecated_at)`);

  // ── 3. Resolution provenance on the ledger ───────────────────────────────────────────────────────
  // NULL = interactive; 'automation' = a resolution rule; 'imported' = a signed resolution bundle.
  safeExec(db, `ALTER TABLE upgrade_details ADD COLUMN resolution_source TEXT`); // throws if present → skipped
}
