import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m154 — Realm columns on `skills` (Tenancy Realm — extend content-forking beyond prompts).
 *
 * Skills are the design's motivating example: a tenant can already DISABLE a built-in skill for itself
 * (Phase 3 state overlay), but not CUSTOMIZE its instructions without editing the row everyone shares.
 * This classifies every built-in skill as a GLOBAL realm original (same columns @weaveintel/realm reads
 * as for prompts) so a tenant can fork its own copy with provenance + drift, resolved nearest-owner-wins.
 *
 * Skills key on `id` (stable built-in ids), so logical_key = id. Adds the standard realm columns +
 * backfills a stable content_hash over the skill's semantic fields + origin_hash baseline, and the
 * composite unique (logical_key, COALESCE(owner_tenant_id,'')) so a tenant copy sits beside the global.
 * Relabel, zero data movement. Idempotent (guarded ALTERs). Postgres via regenerated schema.
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

/** The semantic fields that define a skill's content (what a Customize would change). */
export const SKILL_SEMANTIC_COLS = [
  'name', 'description', 'category', 'trigger_patterns', 'instructions', 'tool_names', 'examples', 'tags', 'domain_sections', 'execution_contract',
] as const;

export function applyM154RealmColumnsSkills(db: BetterSqlite3.Database): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE skills ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  // logical_key = the built-in skill id.
  safeExec(db, `UPDATE skills SET logical_key = id WHERE logical_key IS NULL OR logical_key = ''`);
  hashSkillRows(db);
  // origin_hash baseline = content (Phase 2 drift starts in-sync).
  safeExec(db, `UPDATE skills SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_skills_logical_owner ON skills(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashSkillRows(db: BetterSqlite3.Database): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${SKILL_SEMANTIC_COLS.join(', ')} FROM skills WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded)
  }
  const upd = db.prepare(`UPDATE skills SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of SKILL_SEMANTIC_COLS) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}
