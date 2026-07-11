// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — the shared "add realm columns to a table" migration helper.
 *
 * m151 and m154–m159 each hand-rolled the identical routine: add the eight realm columns, backfill
 * logical_key from the table's natural key, hash the semantic columns into content_hash, baseline
 * origin_hash for global rows, and create the composite unique `(logical_key, owner_tenant_id)`. This
 * module states that routine ONCE so a family added from here on is ~10 lines: its semantic column list
 * plus one call. (The earlier migrations keep their inline copies — they are frozen history and re-editing
 * applied migrations buys nothing; new families use this.)
 *
 * SQLite side only — Postgres gets the same columns declaratively from the regenerated schema, and the
 * same backfill from `db-postgres/seed.ts` (`backfillRealmContentHash` + a logical_key/origin_hash update).
 */
import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * The columns every realm-enabled table carries: the eight realm columns plus the three deprecation
 * lifecycle columns m160 added to the original families. A family registered from here on gets the full
 * contract in one migration (deprecated_at NULL = live; a deprecated record still resolves but can't be
 * newly forked; superseded_by_id points at its replacement).
 */
export const REALM_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['realm', "TEXT NOT NULL DEFAULT 'global'"],
  ['owner_tenant_id', 'TEXT'],
  ['logical_key', 'TEXT'],
  ['origin_id', 'TEXT'],
  ['origin_hash', 'TEXT'],
  ['content_hash', "TEXT NOT NULL DEFAULT ''"],
  ['track_mode', "TEXT NOT NULL DEFAULT 'pin'"],
  ['share_mode', "TEXT NOT NULL DEFAULT 'private'"],
  // Deprecation lifecycle (m160 parity) — every realm family carries these.
  ['deprecated_at', 'TEXT'],
  ['deprecation_note', 'TEXT'],
  ['superseded_by_id', 'TEXT'],
];

/**
 * Add the realm columns to `table` and backfill them. Idempotent (guarded ALTERs; only-fill updates).
 *
 * @param db the better-sqlite3 database.
 * @param table the table to relabel as realm-enabled.
 * @param logicalKeyExpr a SQL expression (developer-controlled, never user input) that yields the row's
 *   logical key — a bare column (`name`, `key`, `kind`) for a single natural key, or a concatenation for a
 *   composite one (e.g. `provider || '::' || model_id`). Spliced verbatim into the backfill UPDATE.
 * @param semanticCols the columns that make up the content hash (identity + `enabled` deliberately excluded).
 * @returns nothing. Side effects: ALTERs, a logical_key/content_hash/origin_hash backfill, and the composite
 *   unique index `ux_<table>_logical_owner`.
 */
export function applyRealmColumns(
  db: BetterSqlite3.Database,
  table: string,
  logicalKeyExpr: string,
  semanticCols: readonly string[],
): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  safeExec(db, `UPDATE ${table} SET logical_key = ${logicalKeyExpr} WHERE logical_key IS NULL OR logical_key = ''`);
  hashRows(db, table, semanticCols);
  safeExec(db, `UPDATE ${table} SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_logical_owner ON ${table}(logical_key, COALESCE(owner_tenant_id, ''))`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_${table}_deprecated ON ${table}(deprecated_at)`); // m160 parity
}

/** Hash each row's semantic columns into content_hash (only rows missing one). Guarded for older DBs. */
function hashRows(db: BetterSqlite3.Database, table: string, semanticCols: readonly string[]): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${semanticCols.join(', ')} FROM ${table} WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded, matches the m154–m159 convention)
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
