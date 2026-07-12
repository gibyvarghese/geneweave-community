import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';
import { realmContentHash, parseRealmSemantic } from './m151-realm-columns.js';

/**
 * m168 — Realm columns on `model_capability_scores`, converged onto the STANDARD realm pattern.
 *
 * Capability scores predate the realm and used their OWN ownership: `tenant_id` (NULL = global) plus a
 * table-level `UNIQUE(tenant_id, model_id, provider, task_key)`. This folds them onto the same shape every
 * other realm family uses — `owner_tenant_id` as the owner, `logical_key` = the `(provider, model, task)`
 * cell, and the composite `UNIQUE(logical_key, owner_tenant_id)` — so governance, drift, badges, and the
 * seed reconcile all work uniformly. `tenant_id` is kept in lockstep with `owner_tenant_id` (both written
 * together) for backward compatibility, but `owner_tenant_id` is now the canonical owner.
 *
 * Dropping the old table-level UNIQUE requires a table rebuild (SQLite cannot ALTER away an inline
 * constraint). The rebuild is driven by `PRAGMA table_info` — it copies EVERY existing column verbatim
 * (whatever later migrations added: production signals, supports_computer_use/long_context/realtime_audio,
 * …) so nothing is lost — then appends the realm columns and the new unique. Idempotent: once `realm`
 * exists the rebuild is skipped and only the index/backfill are ensured. Postgres gets the same shape via
 * the regenerated schema.
 */

/**
 * The config fields that define a capability score's SHIPPED content — what a release changes and drift
 * compares. Deliberately EXCLUDES the auto-updating production telemetry (`production_signal_score`,
 * `signal_sample_count`, `last_evaluated_at`) so a live install doesn't perpetually read as "drifted", and
 * excludes identity (tenant/owner/model/provider/task) + timestamps.
 */
export const CAPABILITY_SCORE_SEMANTIC_COLS = [
  'quality_score', 'supports_tools', 'supports_streaming', 'supports_thinking', 'supports_json_mode',
  'supports_vision', 'supports_computer_use', 'supports_long_context', 'supports_realtime_audio',
  'max_output_tokens', 'benchmark_source', 'raw_benchmark_score', 'is_active',
] as const;

/** The realm + deprecation columns appended to the rebuilt table (mirrors realm-columns-helper.REALM_COLUMNS). */
const REALM_COLUMNS: Array<[string, string]> = [
  ['realm', "TEXT NOT NULL DEFAULT 'global'"],
  ['owner_tenant_id', 'TEXT'],
  ['logical_key', 'TEXT'],
  ['origin_id', 'TEXT'],
  ['origin_hash', 'TEXT'],
  ['content_hash', "TEXT NOT NULL DEFAULT ''"],
  ['track_mode', "TEXT NOT NULL DEFAULT 'pin'"],
  ['share_mode', "TEXT NOT NULL DEFAULT 'private'"],
  ['deprecated_at', 'TEXT'],
  ['deprecation_note', 'TEXT'],
  ['superseded_by_id', 'TEXT'],
];

const CELL_KEY_SQL = `provider || '::' || model_id || '::' || task_key`;

interface PragmaCol { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

export function applyM168RealmColumnsCapabilityScores(db: BetterSqlite3.Database): void {
  let cols: PragmaCol[];
  try {
    cols = db.prepare(`PRAGMA table_info(model_capability_scores)`).all() as PragmaCol[];
  } catch {
    return; // table doesn't exist on this DB — nothing to do
  }
  if (cols.length === 0) return;
  const hasRealm = cols.some((c) => c.name === 'realm');

  if (!hasRealm) {
    rebuildWithRealmColumns(db, cols);
  }
  // Backfill content hashes (JS, over the config cols) + origin baseline, and (re)create indexes. Safe to
  // run every time this migration is (re)applied; guarded so a partially-migrated DB self-heals.
  hashRows(db);
  safeExec(db, `UPDATE model_capability_scores SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
  ensureIndexes(db);
}

/**
 * Rebuild the table WITHOUT the inline UNIQUE, preserving every existing column, and append the realm
 * columns + backfill realm/owner_tenant_id/logical_key from the old ownership.
 */
function rebuildWithRealmColumns(db: BetterSqlite3.Database, cols: PragmaCol[]): void {
  const colDdl = cols.map((c) => {
    let d = `"${c.name}" ${c.type}`;
    if (c.pk) d += ' PRIMARY KEY';
    if (c.notnull) d += ' NOT NULL';
    // PRAGMA returns a function default (e.g. datetime('now')) WITHOUT the parens a column DEFAULT needs;
    // wrap every default in parens — valid for a literal ('global', 1) and an expression alike.
    if (c.dflt_value !== null) d += ` DEFAULT (${c.dflt_value})`;
    return d;
  });
  const realmDdl = REALM_COLUMNS.map(([n, t]) => `"${n}" ${t}`);
  const origNames = cols.map((c) => `"${c.name}"`);

  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE model_capability_scores__m168 (\n  ${[...colDdl, ...realmDdl].join(',\n  ')}\n)`);
    db.exec(
      `INSERT INTO model_capability_scores__m168 (${[...origNames, '"realm"', '"owner_tenant_id"', '"logical_key"'].join(', ')})\n` +
        `SELECT ${origNames.join(', ')}, ` +
        `CASE WHEN tenant_id IS NULL OR tenant_id = '' THEN 'global' ELSE 'tenant' END, ` +
        `tenant_id, ` +
        `${CELL_KEY_SQL} ` +
        `FROM model_capability_scores`,
    );
    db.exec(`DROP TABLE model_capability_scores`);
    db.exec(`ALTER TABLE model_capability_scores__m168 RENAME TO model_capability_scores`);
  });
  tx();
}

/** Compute content_hash over the config semantic cols for rows missing it. */
function hashRows(db: BetterSqlite3.Database): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT id, ${CAPABILITY_SCORE_SEMANTIC_COLS.join(', ')} FROM model_capability_scores WHERE content_hash IS NULL OR content_hash = ''`).all() as Array<Record<string, unknown>>;
  } catch {
    return;
  }
  const upd = db.prepare(`UPDATE model_capability_scores SET content_hash = ? WHERE id = ?`);
  const tx = db.transaction((batch: Array<Record<string, unknown>>) => {
    for (const r of batch) {
      const semantic: Record<string, unknown> = {};
      for (const c of CAPABILITY_SCORE_SEMANTIC_COLS) semantic[c] = parseRealmSemantic(r[c]);
      upd.run(realmContentHash(semantic), r['id']);
    }
  });
  tx(rows);
}

/** (Re)create the realm unique + the pre-existing lookup indexes (the rebuild dropped them with the table). */
function ensureIndexes(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_model_capability_scores_logical_owner ON model_capability_scores(logical_key, COALESCE(owner_tenant_id, ''))`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_lookup ON model_capability_scores(task_key, is_active, owner_tenant_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_model ON model_capability_scores(model_id, provider)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_model_capability_scores_deprecated ON model_capability_scores(deprecated_at)`);
}
