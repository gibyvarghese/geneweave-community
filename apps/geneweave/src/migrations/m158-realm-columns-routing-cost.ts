import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m158 — Realm columns on `routing_policies` + `cost_policies` (Tenancy Realm — extend content-forking
 * to model-routing and cost policies).
 *
 * Classifies every built-in routing/cost policy as a GLOBAL realm original so a tenant can fork its own
 * copy (customize the routing strategy/weights/fallbacks, or the cost tier/levers) with provenance +
 * drift, resolved nearest-owner-wins.
 *
 *   • routing_policies keys on `name` with NO UNIQUE constraint (the guardrails case) — a fork KEEPS the
 *     same name; logical_key = name; resolution is plain nearest-owner-wins.
 *   • cost_policies keys on `key UNIQUE` (the tool_policies case) — a fork can't reuse the key, so it
 *     takes a tenant-scoped `key#tenant` while logical_key = the shared key; the resolver restores the
 *     canonical key on the effective row.
 *
 * Adds the standard realm columns to both + backfills content_hash over each table's semantic fields
 * (excludes name/key identity + enabled — enable/disable is the state overlay's job) + origin_hash
 * baseline + composite unique (logical_key, COALESCE(owner_tenant_id,'')).
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

/** routing_policies semantic (routing rules) — excludes name (identity) + enabled (state overlay). */
export const ROUTING_SEMANTIC_COLS = [
  'description', 'strategy', 'constraints', 'weights', 'fallback_model', 'fallback_provider', 'fallback_chain',
] as const;

/** cost_policies semantic (cost tier + lever overrides) — excludes key (identity) + enabled (state overlay). */
export const COST_SEMANTIC_COLS = ['tier', 'levers_json', 'description'] as const;

/** Add the realm columns + backfill logical_key/content_hash/origin_hash + composite unique for one table. */
function applyRealmColumns(db: BetterSqlite3.Database, table: string, naturalKey: string, semanticCols: readonly string[]): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  safeExec(db, `UPDATE ${table} SET logical_key = ${naturalKey} WHERE logical_key IS NULL OR logical_key = ''`);
  hashRows(db, table, semanticCols);
  safeExec(db, `UPDATE ${table} SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_logical_owner ON ${table}(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashRows(db: BetterSqlite3.Database, table: string, semanticCols: readonly string[]): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${semanticCols.join(', ')} FROM ${table} WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded)
  }
  const upd = db.prepare(`UPDATE ${table} SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of semanticCols) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}

export function applyM158RealmColumnsRoutingCost(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'routing_policies', 'name', ROUTING_SEMANTIC_COLS);
  applyRealmColumns(db, 'cost_policies', 'key', COST_SEMANTIC_COLS);
}
