import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m159 — Realm columns on `prompt_strategies` + `prompt_contracts` + `prompt_frameworks` (Tenancy Realm —
 * extend content-forking to the prompt catalog: execution strategies, output contracts, section frameworks).
 *
 * Classifies every built-in catalog row as a GLOBAL realm original so a tenant can fork its own copy
 * (customize a strategy's instructions, a contract's rules, a framework's sections) with provenance + drift,
 * resolved nearest-owner-wins. All three key on `key UNIQUE` (like tool_policies/cost_policies), so a fork
 * can't reuse the key: `logical_key = key` is the shared identity, a fork takes a tenant-scoped `key#tenant`,
 * and resolution keys on logical_key (the resolver restores the canonical key on the effective row).
 *
 * Adds the standard realm columns to all three + backfills content_hash over each table's semantic fields
 * (excludes key identity + enabled — enable/disable is the state overlay's job) + origin_hash baseline +
 * composite unique (logical_key, COALESCE(owner_tenant_id,'')). Relabel, zero data movement. Idempotent
 * (frameworks/strategies are seeded in seedDefaultData, so the backfill is re-run there). Postgres via
 * regenerated schema.
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

/** Semantic (content) fields per table — exclude `key` (identity/logical_key) + `enabled` (state overlay). */
export const STRATEGY_SEMANTIC_COLS = ['name', 'description', 'instruction_prefix', 'instruction_suffix', 'config'] as const;
export const CONTRACT_SEMANTIC_COLS = ['name', 'description', 'contract_type', 'schema', 'config'] as const;
export const FRAMEWORK_SEMANTIC_COLS = ['name', 'description', 'sections', 'section_separator'] as const;

/** Add the realm columns + backfill logical_key/content_hash/origin_hash + composite unique for one keyed table. */
function applyRealmColumns(db: BetterSqlite3.Database, table: string, semanticCols: readonly string[]): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  // logical_key = the row's canonical `key` (shared identity of a global + its tenant forks).
  safeExec(db, `UPDATE ${table} SET logical_key = key WHERE logical_key IS NULL OR logical_key = ''`);
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

export function applyM159RealmColumnsPromptCatalog(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'prompt_strategies', STRATEGY_SEMANTIC_COLS);
  applyRealmColumns(db, 'prompt_contracts', CONTRACT_SEMANTIC_COLS);
  applyRealmColumns(db, 'prompt_frameworks', FRAMEWORK_SEMANTIC_COLS);
}
