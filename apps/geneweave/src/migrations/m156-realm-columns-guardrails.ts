import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m156 — Realm columns on `guardrails` (Tenancy Realm — extend content-forking to guardrail policies).
 *
 * Classifies every built-in guardrail as a GLOBAL realm original so a tenant can fork its own copy
 * (customize a guardrail's config — thresholds, patterns, judge model, compliance framework) with
 * provenance + drift, resolved nearest-owner-wins.
 *
 * Unlike worker_agents, `guardrails.name` has NO UNIQUE constraint, so a fork can keep the SAME name
 * (no tenant-scoped alias, no name restoration on resolve). logical_key = name is the shared identity
 * of a global and its tenant forks. Adds the standard realm columns + backfills content_hash over the
 * guardrail's semantic fields (the policy content; excludes name/priority/enabled — enable/priority are
 * the state-overlay's job, not a content fork) + origin_hash baseline + composite unique
 * (logical_key, COALESCE(owner_tenant_id,'')).
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
 * The semantic fields that define a guardrail's POLICY content (what a Customize changes). Excludes
 * `name` (the identity/logical_key) and `priority`/`enabled` (per-tenant tuning is the state overlay's
 * job — realm_tenant_state — not a content fork). All TEXT columns → byte-identical hash across engines.
 */
export const GUARDRAIL_SEMANTIC_COLS = [
  'description', 'type', 'stage', 'config', 'trigger_conditions', 'trigger_description', 'judge_model', 'compliance_framework',
] as const;

export function applyM156RealmColumnsGuardrails(db: BetterSqlite3.Database): void {
  for (const [col, type] of REALM_COLUMNS) {
    safeExec(db, `ALTER TABLE guardrails ADD COLUMN ${col} ${type}`); // ADD COLUMN throws if it exists → skipped
  }
  // logical_key = the guardrail's name (shared identity of a global + its tenant forks).
  safeExec(db, `UPDATE guardrails SET logical_key = name WHERE logical_key IS NULL OR logical_key = ''`);
  hashGuardrailRows(db);
  safeExec(db, `UPDATE guardrails SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_guardrails_logical_owner ON guardrails(logical_key, COALESCE(owner_tenant_id, ''))`);
}

function hashGuardrailRows(db: BetterSqlite3.Database): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${GUARDRAIL_SEMANTIC_COLS.join(', ')} FROM guardrails WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return; // a column missing on an older DB — skip (guarded)
  }
  const upd = db.prepare(`UPDATE guardrails SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of GUARDRAIL_SEMANTIC_COLS) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}
