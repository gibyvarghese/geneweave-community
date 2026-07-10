// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — write-path & governance (Section D).
 *
 * Two additions, both about *governing* the realm rather than resolving it:
 *
 *  1. `realm_proposals` — the review queue behind **ProposeToRealm** (D12). Until now a tenant's
 *     improved fork could only be pushed straight into the global default by whoever held admin
 *     credentials (`POST /:id/promote`, ungated). Now a tenant admin *proposes* the fork, it lands
 *     here as `pending`, and only a **platform admin** may approve (which performs the promote) or
 *     reject it. Modeled on `mined_skill_proposals` (m149), the existing review-queue precedent.
 *
 *  2. Deprecation columns on every realm-enabled table (D15). A global default can be marked
 *     **deprecated** — it keeps resolving for tenants already using it (nothing breaks), but it can
 *     no longer be freshly customized, and `superseded_by_id` points operators at its replacement.
 *     `deprecated_at` NULL = live. This is a *global lifecycle* concern (a built-in is retired for
 *     everyone), which is why it's a base column rather than a per-tenant state overlay.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS`, and `ADD COLUMN` throws-and-is-skipped when present.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/** Every realm-enabled content table gets the deprecation lifecycle columns. */
export const REALM_TABLES = [
  'prompts', 'prompt_fragments', 'skills', 'worker_agents', 'guardrails', 'tool_policies',
  'routing_policies', 'cost_policies', 'prompt_strategies', 'prompt_contracts', 'prompt_frameworks',
] as const;

/** NULL `deprecated_at` = live. A deprecated record still resolves; it just can't be newly forked. */
const DEPRECATION_COLUMNS: Array<[string, string]> = [
  ['deprecated_at', 'TEXT'],
  ['deprecation_note', 'TEXT'],
  ['superseded_by_id', 'TEXT'],
];

export function applyM160RealmGovernance(db: BetterSqlite3.Database): void {
  // ── D12: the ProposeToRealm review queue ──────────────────────────────────
  // One row per proposal that a tenant's fork (`fork_id`, in `family`) become the global default for
  // `logical_key`. `status` is pending → approved | rejected; approval runs the promote.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS realm_proposals (
      id TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      fork_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_note TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_realm_proposals_status ON realm_proposals(status, created_at)`);
  // At most ONE pending proposal per fork — re-proposing the same fork is an update, not a duplicate.
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_realm_proposals_pending_fork ON realm_proposals(fork_id) WHERE status = 'pending'`);

  // ── D15: deprecation lifecycle on every realm table ───────────────────────
  for (const table of REALM_TABLES) {
    for (const [col, type] of DEPRECATION_COLUMNS) {
      safeExec(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); // throws if present → skipped
    }
    safeExec(db, `CREATE INDEX IF NOT EXISTS idx_${table}_deprecated ON ${table}(deprecated_at)`);
  }
}
