import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m157 — Realm columns on `tool_policies` (Tenancy Realm — extend content-forking to tool policies).
 *
 * Classifies every built-in tool policy as a GLOBAL realm original so a tenant can fork its own copy
 * (customize a policy's gates — approval, rate limits, allowed risk levels, dry-run, time windows) with
 * provenance + drift, resolved nearest-owner-wins by the DbToolPolicyResolver at tool-call time.
 *
 * tool_policies keys on `key UNIQUE` (an inline column constraint that can't be dropped without a table
 * rebuild), so a fork can't reuse the key: `logical_key = key` is the shared identity, and a fork takes a
 * tenant-scoped `key#tenant` while resolution keys on logical_key — the resolver restores the canonical
 * key on the effective row. Adds the standard realm columns + backfills content_hash over the policy's
 * semantic fields (EXCLUDING key/name identity + enabled — per-tenant enable/disable is the state
 * overlay's job) + origin_hash baseline + composite unique (logical_key, COALESCE(owner_tenant_id,'')).
 * Relabel, zero data movement. Idempotent. Postgres via regenerated schema.
 */
const REALM_COLUMNS: Array<[string, string]> = [
  ['realm', "TEXT NOT NULL DEFAULT 'global'"],
  ['owner_tenant_id', 'TEXT'],
  ['logical_key', 'TEXT'],
  ['origin_id', 'TEXT'],
  ['origin_hash', 'TEXT'],
  ['content_hash', "TEXT NOT NULL DEFAULT ''"],
  ['track_mode', "TEXT NOT NULL DEFAULT 'pin'"],
  ['share_mode', "TEXT NOT NULL DEFAULT 'private'"],
];

/**
 * The semantic fields that define a tool policy's GATE content (what a Customize changes). Excludes
 * `key`/`name` (identity/logical_key) and `enabled` (per-tenant enable/disable is the state overlay's
 * job — realm_tenant_state — not a content fork).
 */
export const TOOLPOLICY_SEMANTIC_COLS = [
  'description', 'applies_to', 'applies_to_risk_levels', 'approval_required', 'allowed_risk_levels',
  'max_execution_ms', 'rate_limit_per_minute', 'max_concurrent', 'require_dry_run', 'log_input_output',
  'persona_scope', 'active_hours_utc', 'expires_at',
] as const;

export function applyM157RealmColumnsToolPolicies(db: BetterSqlite3.Database): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE tool_policies ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  // logical_key = the policy's canonical key (shared identity of a global + its tenant forks).
  safeExec(db, `UPDATE tool_policies SET logical_key = key WHERE logical_key IS NULL OR logical_key = ''`);
  hashToolPolicyRows(db);
  safeExec(db, `UPDATE tool_policies SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_tool_policies_logical_owner ON tool_policies(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashToolPolicyRows(db: BetterSqlite3.Database): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${TOOLPOLICY_SEMANTIC_COLS.join(', ')} FROM tool_policies WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded)
  }
  const upd = db.prepare(`UPDATE tool_policies SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of TOOLPOLICY_SEMANTIC_COLS) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}
