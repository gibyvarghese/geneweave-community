import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m155 — Realm columns on `worker_agents` (Tenancy Realm — extend content-forking to supervisor workers).
 *
 * Classifies every built-in worker agent as a GLOBAL realm original so a tenant can fork its own copy
 * (customize a worker's system_prompt / tools) with provenance + drift, resolved nearest-owner-wins.
 *
 * worker_agents keys on `name UNIQUE` (an inline column constraint that can't be dropped without a table
 * rebuild), so a fork can't reuse the name. Instead logical_key = name (the shared identity), and a fork
 * takes a tenant-scoped name (name#tenant) while resolution keys on logical_key — the resolver restores
 * the canonical name on the effective row. Adds the standard realm columns + backfills content_hash over
 * the worker's semantic fields (EXCLUDING name, so a fork's suffixed name doesn't count as drift) +
 * origin_hash baseline + composite unique (logical_key, COALESCE(owner_tenant_id,'')).
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

/** The semantic fields that define a worker's content (what a Customize changes). Excludes `name`. */
export const WORKER_SEMANTIC_COLS = [
  'display_name', 'job_profile', 'description', 'system_prompt', 'tool_names', 'persona', 'trigger_patterns', 'task_contract_id', 'category',
] as const;

export function applyM155RealmColumnsWorkerAgents(db: BetterSqlite3.Database): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE worker_agents ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  // logical_key = the worker's canonical name.
  safeExec(db, `UPDATE worker_agents SET logical_key = name WHERE logical_key IS NULL OR logical_key = ''`);
  hashWorkerRows(db);
  safeExec(db, `UPDATE worker_agents SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_worker_agents_logical_owner ON worker_agents(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashWorkerRows(db: BetterSqlite3.Database): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${WORKER_SEMANTIC_COLS.join(', ')} FROM worker_agents WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded)
  }
  const upd = db.prepare(`UPDATE worker_agents SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of WORKER_SEMANTIC_COLS) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}
