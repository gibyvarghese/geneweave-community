/**
 * Tenancy Realm Phase 2 (app) — keep built-in prompt defaults and operator edits from clobbering each
 * other across product upgrades. This is the "conffile on upgrade" problem: we ship default prompts, an
 * operator edits a few, a new release changes some of those same defaults. What should happen?
 *
 * Three hashes decide it — exactly what @weaveintel/realm's reconcile engine does, wired to the app's
 * `prompts` table + a `realm_versions` log:
 *   • Base   = the version we shipped last time      → the global row's `origin_hash`
 *   • Local  = what's in the prompts table now        → the global row's `content_hash` (operator edits)
 *   • Remote = the current release's default          → `realm_versions` latest (maintained by seed)
 *
 * so drift is: in_sync · customized (keep theirs) · stale (adopt ours) · diverged (review).
 *
 * Everything runs through the framework's `SqlClient` seam, so ONE implementation serves both SQLite
 * (seedDefaultData) and Postgres (pgSeedStore) — no per-engine copy.
 */
import {
  createSqlVersionLog, classifyDrift,
  type SqlClient, type SqlDialect, type ReconcileState,
} from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import type { PromptRow } from './db-types/prompts.js';

export const PROMPT_FAMILY = 'prompts';
/** Semantic columns that define a prompt's content — identical to m151's hash set. */
const SEMANTIC_COLS = ['name', 'description', 'category', 'template', 'variables', 'model_compatibility', 'execution_defaults', 'framework'] as const;
type SemanticCol = (typeof SEMANTIC_COLS)[number];

type Semantic = Record<string, unknown>;
type PromptDefault = Record<string, unknown>;

/** The parsed semantic object we hash (JSON columns parsed) — matches how m151 computed content_hash. */
function semanticOf(src: Record<string, unknown>): Semantic {
  const out: Semantic = {};
  for (const c of SEMANTIC_COLS) out[c] = parseRealmSemantic(src[c]);
  return out;
}
/** Hash a row's CURRENT semantic columns — Local computed live, so an operator edit is always seen even
 *  if whatever wrote it didn't refresh the stored content_hash. Base (origin_hash) stays authoritative. */
const hashRowLive = (row: Record<string, unknown>): string => realmContentHash(semanticOf(row));
const logicalKeyOf = (r: { logical_key?: string | null; key?: string | null; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.key ?? undefined) || String(r.id ?? '');

/** A better-sqlite3 database wrapped as the framework's async SqlClient (the ~6-line adapter). */
export function sqliteSqlClient(db: { prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } }): SqlClient {
  return {
    async query(text, params = []) {
      const stmt = db.prepare(text);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(text)) return { rows: stmt.all(...(params as unknown[])) as Array<Record<string, unknown>> };
      stmt.run(...(params as unknown[]));
      return { rows: [] };
    },
  };
}

interface Ctx { client: SqlClient; dialect: SqlDialect; }
const ph = (d: SqlDialect, i: number) => (d === 'postgres' ? `$${i}` : '?');

/**
 * Seed-time reconcile: bring the `prompts`/`realm_versions` tables in line with the release's defaults.
 * Records each default as a version (the Remote baseline), backfills `origin_hash` for fresh rows, and
 * — the key fix over the old insert-only seed — ADOPTS a new default automatically when the operator
 * never touched it (stale), while leaving customized/diverged rows exactly as the operator left them.
 * Idempotent: re-running with unchanged defaults changes nothing.
 */
export async function reconcilePromptRealm(
  client: SqlClient, dialect: SqlDialect, defaults: ReadonlyArray<Record<string, unknown>>, opts: { at?: string; publishedBy?: string } = {},
): Promise<{ adopted: string[]; published: string[]; review: Array<{ logicalKey: string; state: ReconcileState }> }> {
  const ctx: Ctx = { client, dialect };
  const log = createSqlVersionLog<Semantic>({ client, dialect, table: 'realm_versions' });
  const adopted: string[] = [];
  const published: string[] = [];
  const review: Array<{ logicalKey: string; state: ReconcileState }> = [];

  for (const def of defaults) {
    const logicalKey = logicalKeyOf(def);
    if (!logicalKey) continue;
    const semantic = semanticOf(def as Record<string, unknown>);
    const remote = realmContentHash(semantic);
    // Record the current default as a version (content-addressed: no-op if unchanged). Remote = latest.
    await log.append({ family: PROMPT_FAMILY, logicalKey, payload: semantic, at: opts.at, publishedBy: opts.publishedBy, note: 'seed' });

    const row = await getGlobalRow(ctx, logicalKey);
    if (!row) { published.push(logicalKey); continue; } // seed loop inserts rows; nothing here yet

    const base = (row['origin_hash'] as string | null) || null;
    const local = hashRowLive(row); // Local computed from the row's current columns (see hashRowLive)
    // Fresh row with no baseline yet → adopt current content as Base.
    if (!base) { await setOrigin(ctx, String(row['id']), local); continue; }

    const state = classifyDrift(base, local, remote);
    if (state === 'stale') {
      await adoptDefault(ctx, String(row['id']), def, remote);
      adopted.push(logicalKey);
    } else if (state === 'customized' || state === 'diverged') {
      review.push({ logicalKey, state });
    }
  }

  // Baseline every OTHER global too (some built-ins are seeded after seedDefaultData, e.g. sv-seed).
  await ensurePromptBaselines(client, dialect, opts);
  return { adopted, published, review };
}

/**
 * Give every global prompt a baseline (a realm_versions entry + origin_hash) if it doesn't have one —
 * self-healing so a built-in seeded by any path becomes "managed". Idempotent: only fills gaps, using
 * the row's CURRENT content as the baseline. Called by the seed reconcile and (as read-repair) by the
 * drift report + resync, so drift is always measured against a real baseline.
 */
export async function ensurePromptBaselines(client: SqlClient, dialect: SqlDialect, opts: { at?: string } = {}): Promise<void> {
  const ctx: Ctx = { client, dialect };
  const log = createSqlVersionLog<Semantic>({ client, dialect, table: 'realm_versions' });
  const have = await log.latestAll(PROMPT_FAMILY);
  const { rows } = await client.query(`SELECT * FROM prompts WHERE realm = 'global'`);
  for (const row of rows) {
    const lk = logicalKeyOf(row);
    if (!lk || have.has(lk)) continue;
    await log.append({ family: PROMPT_FAMILY, logicalKey: lk, payload: semanticOf(row), at: opts.at, note: 'baseline' });
    if (!(row['origin_hash'] as string | null)) await setOrigin(ctx, String(row['id']), hashRowLive(row));
  }
}

async function getGlobalRow(ctx: Ctx, logicalKey: string): Promise<Record<string, unknown> | null> {
  const { rows } = await ctx.client.query(
    `SELECT * FROM prompts WHERE realm = 'global' AND COALESCE(NULLIF(logical_key,''), key, id) = ${ph(ctx.dialect, 1)} LIMIT 1`,
    [logicalKey],
  );
  return rows[0] ?? null;
}
async function setOrigin(ctx: Ctx, id: string, hash: string): Promise<void> {
  await ctx.client.query(`UPDATE prompts SET origin_hash = ${ph(ctx.dialect, 1)} WHERE id = ${ph(ctx.dialect, 2)}`, [hash, id]);
}
/** Overwrite a global row's semantic columns with the shipped default and re-baseline (Base=Local=Remote). */
async function adoptDefault(ctx: Ctx, id: string, def: PromptDefault, remote: string): Promise<void> {
  const sets = SEMANTIC_COLS.map((c, i) => `${c} = ${ph(ctx.dialect, i + 1)}`);
  // JSON columns may arrive parsed (from a version-log payload) — re-stringify so both engines can bind.
  const vals: unknown[] = SEMANTIC_COLS.map((c) => {
    const v = (def as Record<string, unknown>)[c];
    if (v == null) return null;
    return typeof v === 'object' ? JSON.stringify(v) : v;
  });
  sets.push(`content_hash = ${ph(ctx.dialect, vals.length + 1)}`); vals.push(remote);
  sets.push(`origin_hash = ${ph(ctx.dialect, vals.length + 1)}`); vals.push(remote);
  vals.push(id);
  await ctx.client.query(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ${ph(ctx.dialect, vals.length)}`, vals);
}

export interface PromptDriftEntry {
  id: string;
  logicalKey: string;
  name: string;
  state: ReconcileState;
  base: string | null;
  local: string | null;
  remote: string | null;
}
export interface PromptDriftReport {
  entries: PromptDriftEntry[];
  summary: Record<ReconcileState, number>;
}

/** Read-only drift report over the global prompts — "which built-ins have you customized / are stale". */
export async function promptDriftReport(client: SqlClient, dialect: SqlDialect): Promise<PromptDriftReport> {
  await ensurePromptBaselines(client, dialect); // self-heal baselines for any un-versioned built-in first
  const log = createSqlVersionLog<Semantic>({ client, dialect, table: 'realm_versions' });
  const remoteByKey = await log.latestAll(PROMPT_FAMILY);
  const { rows } = await client.query(`SELECT * FROM prompts WHERE realm = 'global' ORDER BY name`);
  const summary: Record<ReconcileState, number> = { in_sync: 0, customized: 0, stale: 0, diverged: 0, new: 0, removed: 0 };
  const entries: PromptDriftEntry[] = [];
  for (const r of rows) {
    const logicalKey = logicalKeyOf(r);
    const base = (r['origin_hash'] as string | null) || null;
    const local = hashRowLive(r); // computed from current columns, not the stored content_hash
    const remote = remoteByKey.get(logicalKey)?.contentHash ?? null;
    // A global built-in with no recorded package baseline yet (e.g. seeded by a migration after the
    // reconcile ran) isn't "removed" — it's just unversioned. Compare it against its own baseline:
    // untouched → in_sync, edited → customized. We simply can't detect package changes for it.
    const state = remote == null
      ? (base && local !== base ? 'customized' : 'in_sync')
      : classifyDrift(base, local, remote);
    summary[state] += 1;
    entries.push({ id: String(r['id']), logicalKey, name: String(r['name']), state, base, local, remote });
  }
  return { entries, summary };
}

/**
 * Operator chooses "take the shipped version" for a customized/diverged built-in — apply the current
 * release default (from the version log) and re-baseline so drift returns to in_sync.
 */
export async function resyncPromptToPackage(client: SqlClient, dialect: SqlDialect, promptId: string): Promise<{ ok: boolean; reason?: string }> {
  const ctx: Ctx = { client, dialect };
  await ensurePromptBaselines(client, dialect); // ensure a baseline exists before we try to resync
  const { rows } = await client.query(`SELECT id, realm, logical_key, key FROM prompts WHERE id = ${ph(dialect, 1)}`, [promptId]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not found' };
  if (row['realm'] !== 'global') return { ok: false, reason: 'not a global prompt' };
  const logicalKey = logicalKeyOf(row);
  const log = createSqlVersionLog<Semantic>({ client, dialect, table: 'realm_versions' });
  const latest = await log.latest(PROMPT_FAMILY, logicalKey);
  if (!latest) return { ok: false, reason: 'no package version recorded' };
  await adoptDefault(ctx, promptId, latest.payload as unknown as PromptDefault, latest.contentHash);
  return { ok: true };
}
