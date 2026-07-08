import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { safeExec } from './helpers.js';

/**
 * m151 — Realm columns on prompts + prompt_fragments (Tenancy Realm, Phase 0→1 groundwork).
 *
 * Phase 0 made tenants real (m150). This migration classifies the existing prompt configuration as
 * the GLOBAL realm, so a tenant can later fork its own copy with provenance and drift — exactly the
 * columns `@weaveintel/realm` (Phase 1) reads. It is a relabel, not a data move: every current row
 * becomes a "global original" (realm='global', no owner), and picks up a stable content hash so a
 * future package update can tell "the operator customized this" from "this is stale".
 *
 * Columns added (mirrors @weaveintel/realm's realmConfigDdl shape):
 *   realm 'global'|'tenant', owner_tenant_id, logical_key, origin_id, origin_hash, content_hash,
 *   track_mode 'pin'|'track_latest', share_mode 'private'|'children'|'subtree'.
 * Uniqueness becomes (logical_key, COALESCE(owner_tenant_id,'')) so a tenant's copy sits beside the
 * global one. logical_key is backfilled from the visible key (prompts.key ?? id; fragments.key).
 *
 * Dual-engine: Postgres gets the same columns via the regenerated POSTGRES_FULL_SCHEMA; the same
 * logical_key/content_hash backfill runs in db-postgres/seed.ts. Idempotent (guarded ALTERs).
 */

/** Deterministic content hash over the *semantic* fields — identical to @weaveintel/realm's computeContentHash. */
export function realmContentHash(semantic: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortDeep(semantic));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

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

export function applyM151RealmColumns(db: BetterSqlite3.Database): void {
  for (const table of ['prompts', 'prompt_fragments']) {
    for (const [col, type] of REALM_COLUMNS) {
      safeExec(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
    }
  }

  // Backfill logical_key: prompts use key-or-id; fragments use key.
  safeExec(db, `UPDATE prompts SET logical_key = COALESCE(NULLIF(key, ''), id) WHERE logical_key IS NULL OR logical_key = ''`);
  safeExec(db, `UPDATE prompt_fragments SET logical_key = COALESCE(NULLIF(key, ''), id) WHERE logical_key IS NULL OR logical_key = ''`);

  // Compute content hashes in JS so existing rows are proper global originals (only for empty ones).
  hashRows(db, 'prompts', ['name', 'description', 'category', 'template', 'variables', 'model_compatibility', 'execution_defaults', 'framework']);
  hashRows(db, 'prompt_fragments', ['name', 'description', 'category', 'content', 'variables']);

  // One copy per (logical_key, owner). COALESCE folds the global NULL owner to '' so it's unique too.
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_logical_owner ON prompts(logical_key, COALESCE(owner_tenant_id, ''))`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_prompt_fragments_logical_owner ON prompt_fragments(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashRows(db: BetterSqlite3.Database, table: string, semanticCols: string[]): void {
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

/** JSON columns (variables, model_compatibility, …) are stored as text — hash their parsed value. */
export function parseRealmSemantic(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  const s = v.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}
