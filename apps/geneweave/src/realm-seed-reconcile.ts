// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — registry-driven seed-time reconcile for EVERY realm family.
 *
 * This is the generalisation of `realm-prompt-drift.ts`. That module solved the "conffile on upgrade"
 * problem for one table (`prompts`); this module solves it for every entry in `REALM_FAMILIES`, driven by
 * the registry's three facts per family (table, semantic columns, logical-key source). The loop is
 * identical — it just reads *which* table, *which* columns, and *how the logical key is derived* from the
 * spec instead of hardcoding the prompts answers.
 *
 * Per family, per shipped default:
 *   • Publish the default into `realm_versions` (content-addressed → a no-op when unchanged). This is the
 *     Remote leg drift compares against next release — the thing that, before this, only `prompts` had.
 *   • Read the matching GLOBAL row and compute Base (`origin_hash`), Local (hashed live from the row's
 *     current columns, so an out-of-band edit is always seen), Remote (the shipped default's hash).
 *   • Classify with the realm engine's `classifyDrift` and act by the family's auto-adopt policy:
 *       – stale (operator didn't touch it, we changed it) → adopt automatically, unless policy is 'never'
 *       – customized (operator edited, we didn't)         → keep theirs, record for review
 *       – diverged (both changed)                         → keep theirs, record for review (a real merge)
 *       – in_sync                                         → nothing to do
 *   • Every touched record is written to `upgrade_details` under the run, with a priority band, so the
 *     operator can see afterwards exactly what happened.
 *
 * Runs once against the `SqlClient` seam → serves SQLite (seedDefaultData) and Postgres (pgSeedStore).
 * Idempotent: re-running with unchanged defaults changes nothing (content-addressed publish + hash compare).
 */
import { createSqlVersionLog, classifyDrift, type SqlClient, type SqlDialect, type ReconcileState } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { REALM_FAMILIES, logicalKeyOfRow, type RealmFamilySpec } from './realm-families.js';
import { ph } from './realm-sql.js';
import { recordUpgradeDetail, beginUpgradeRun, finishUpgradeRun } from './upgrade-run-store.js';
import { needsReview, type UpgradeDisposition } from './upgrade-priority.js';

/**
 * How aggressively a family adopts a changed shipped default the operator never touched (a `stale`):
 *   • 'always'     — adopt every stale default (safe informational config: pricing, labels).
 *   • 'patch_only' — adopt stale defaults (Phase-0 behaviour). The finer "adopt only patch-level, defer
 *                    larger changes for review" gate is a later refinement (it needs a semver on the
 *                    payload); for now patch_only behaves like always for the untouched case, which is the
 *                    correct and safe outcome — an operator who never touched a default gets our fix.
 *   • 'never'      — never auto-adopt; surface even a stale default for explicit operator review.
 */
export type AutoAdoptPolicy = 'always' | 'patch_only' | 'never';

/**
 * Per-family auto-adopt policy. Conservative by design and easily audited/overridden.
 *
 * NB `prompts` is 'patch_only' here (adopts stale), which PRESERVES the pre-existing `reconcilePromptRealm`
 * behaviour. The design document proposes `never` for prompts (surface every stale prompt for review); that
 * is a one-line change here once the product decides to make it, and is intentionally NOT applied silently
 * because it would change current behaviour and existing tests. See UPGRADE_ENGINE.md.
 */
export const AUTO_ADOPT_POLICY: Readonly<Record<string, AutoAdoptPolicy>> = Object.freeze({
  prompts: 'patch_only',
  prompt_fragments: 'patch_only',
  skills: 'patch_only',
  worker_agents: 'patch_only',
  guardrails: 'patch_only',
  tool_policies: 'patch_only',
  routing_policies: 'patch_only',
  cost_policies: 'patch_only',
  prompt_strategies: 'patch_only',
  prompt_contracts: 'patch_only',
  prompt_frameworks: 'patch_only',
});
/** The adopt policy for a family (defaults to 'patch_only' — adopt untouched changes, keep edits). */
export const adoptPolicyFor = (family: string): AutoAdoptPolicy => AUTO_ADOPT_POLICY[family] ?? 'patch_only';

/** A shipped default: any row-shaped object carrying the family's semantic columns + logical-key source. */
export type RealmDefault = Record<string, unknown>;

/** What a single-family reconcile did. */
export interface FamilyReconcileResult {
  readonly family: string;
  /** Logical keys whose global row was overwritten with the shipped default (stale → adopted). */
  readonly adopted: string[];
  /** Logical keys published as a brand-new default (no global row existed yet). */
  readonly published: string[];
  /** Logical keys left for a human (customized / diverged / stale-but-policy-never). */
  readonly review: Array<{ logicalKey: string; state: ReconcileState }>;
}

interface ReconcileFamilyOptions {
  /** Override the family's default adopt policy (tests / edition policy). */
  readonly policy?: AutoAdoptPolicy;
  /** When set, each touched record is written to upgrade_details under this run. */
  readonly runId?: string;
  /** Timestamp stamp for version-log + detail rows. */
  readonly at?: string;
  readonly publishedBy?: string;
}

/** The parsed semantic object we hash (JSON columns parsed) — matches how the migrations computed content_hash. */
function semanticOf(spec: RealmFamilySpec, src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of spec.semanticCols) out[c] = parseRealmSemantic(src[c]);
  return out;
}
/** Hash a row's CURRENT semantic columns — Local computed live so an operator edit is always seen. */
const hashRowLive = (spec: RealmFamilySpec, row: Record<string, unknown>): string => realmContentHash(semanticOf(spec, row));

/**
 * The content hash of a family row's CURRENT semantic columns — the reconcile's "Local" leg, computed live so
 * an operator edit is always noticed. Exported so the read-only upgrade PREVIEW classifies a live row with the
 * exact same hashing the write-path reconcile uses (no parallel copy that could drift out of agreement).
 * @param spec the family's registry entry (its `semanticCols` define what's hashed).
 * @param row a live DB row for that family.
 * @returns the content hash string.
 */
export function hashLiveRealmRow(spec: RealmFamilySpec, row: Record<string, unknown>): string {
  return hashRowLive(spec, row);
}

/**
 * The SQL that finds a family's GLOBAL row for a logical key. Mirrors the stored `logical_key` first
 * (a fork stores the canonical key there), falling back to the family's natural key column then id — the
 * same COALESCE the realm resolver uses, so seed reconcile and runtime resolution agree on identity.
 */
function globalRowQuery(spec: RealmFamilySpec, dialect: SqlDialect): string {
  return `SELECT * FROM ${spec.table} WHERE realm = 'global' AND COALESCE(NULLIF(logical_key,''), ${spec.logicalKeyFrom}, id) = ${ph(dialect, 1)} LIMIT 1`;
}

/**
 * Fetch a family's GLOBAL row for a logical key using the SAME identity resolution the reconcile and runtime
 * resolver use (stored logical_key → natural key → id). Exported so the read-only preview reads the exact row
 * the write-path would classify. Read-only.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param spec the family's registry entry.
 * @param logicalKey the logical key to look up.
 * @returns the global row, or null if the family has no global row for that key.
 */
export async function fetchGlobalRealmRow(
  client: SqlClient,
  dialect: SqlDialect,
  spec: RealmFamilySpec,
  logicalKey: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(globalRowQuery(spec, dialect), [logicalKey]);
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/** Overwrite a global row's semantic columns with the shipped default and re-baseline (Base=Local=Remote). */
async function adoptDefault(client: SqlClient, dialect: SqlDialect, spec: RealmFamilySpec, id: string, def: RealmDefault, remote: string): Promise<void> {
  const cols = [...spec.semanticCols];
  const sets = cols.map((c, i) => `${c} = ${ph(dialect, i + 1)}`);
  // JSON columns may arrive parsed (from a version-log payload) — re-stringify so both engines can bind.
  const vals: unknown[] = cols.map((c) => {
    const v = def[c];
    if (v == null) return null;
    return typeof v === 'object' ? JSON.stringify(v) : v;
  });
  sets.push(`content_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  sets.push(`origin_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  vals.push(id);
  await client.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ${ph(dialect, vals.length)}`, vals);
}

/**
 * Reconcile ONE family's shipped defaults against the store. The generic core.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param spec the family's registry entry (table, semantic cols, logical-key source).
 * @param defaults the release's shipped defaults for this family (row-shaped objects).
 * @param opts adopt-policy override, an optional run id to record details under, and timestamps.
 * @returns what was adopted / published / left for review. Side effects: version-log appends, in-place
 *          UPDATEs of adopted rows, and (if runId) upgrade_details inserts.
 */
export async function reconcileRealmFamily(
  client: SqlClient,
  dialect: SqlDialect,
  spec: RealmFamilySpec,
  defaults: ReadonlyArray<RealmDefault>,
  opts: ReconcileFamilyOptions = {},
): Promise<FamilyReconcileResult> {
  const log = createSqlVersionLog<Record<string, unknown>>({ client, dialect, table: 'realm_versions' });
  const policy = opts.policy ?? adoptPolicyFor(spec.family);
  const adopted: string[] = [];
  const published: string[] = [];
  const review: Array<{ logicalKey: string; state: ReconcileState }> = [];

  for (const def of defaults) {
    const logicalKey = logicalKeyOfRow(spec, def);
    if (!logicalKey) continue;
    const semantic = semanticOf(spec, def);
    const remote = realmContentHash(semantic);
    // Record the current default as a version (content-addressed: no-op if unchanged). Remote = latest.
    await log.append({ family: spec.family, logicalKey, payload: semantic, at: opts.at, publishedBy: opts.publishedBy, note: 'seed' });

    const { rows } = await client.query(globalRowQuery(spec, dialect), [logicalKey]);
    const row = rows[0];
    if (!row) {
      // No global row yet — the seed's own insert loop creates rows; this default is 'new' here.
      published.push(logicalKey);
      await maybeRecord(client, dialect, opts.runId, { family: spec.family, logicalKey, disposition: 'new', remoteHash: remote });
      continue;
    }

    const base = (row['origin_hash'] as string | null) || null;
    const local = hashRowLive(spec, row);
    // Fresh row with no baseline yet → adopt current content as Base (start in-sync, drift measurable next
    // release). Also stamp content_hash: rows seeded AFTER their migration ran are never re-hashed by the
    // now-ledgered migration runner, so the reconcile is the authoritative populator of both hashes.
    if (!base) {
      await client.query(`UPDATE ${spec.table} SET origin_hash = ${ph(dialect, 1)}, content_hash = ${ph(dialect, 2)} WHERE id = ${ph(dialect, 3)}`, [local, local, String(row['id'])]);
      continue;
    }

    const state = classifyDrift(base, local, remote);
    if (state === 'stale' && policy !== 'never') {
      await adoptDefault(client, dialect, spec, String(row['id']), def, remote);
      adopted.push(logicalKey);
      await maybeRecord(client, dialect, opts.runId, { family: spec.family, logicalKey, disposition: 'adopted', baseHash: base, localHash: local, remoteHash: remote });
    } else if (state === 'customized' || state === 'diverged' || (state === 'stale' && policy === 'never')) {
      review.push({ logicalKey, state });
      await maybeRecord(client, dialect, opts.runId, { family: spec.family, logicalKey, disposition: state as UpgradeDisposition, baseHash: base, localHash: local, remoteHash: remote });
    }
    // in_sync → nothing to do, nothing to record.
  }

  // Baseline every OTHER global (some built-ins are seeded after the reconcile ran, e.g. app-specific seeds).
  await ensureFamilyBaselines(client, dialect, spec, { at: opts.at });
  return { family: spec.family, adopted, published, review };
}

/** Insert an upgrade_details row if a run is active; a no-op otherwise. Keeps the caller branch-free. */
async function maybeRecord(
  client: SqlClient,
  dialect: SqlDialect,
  runId: string | undefined,
  d: { family: string; logicalKey: string; disposition: UpgradeDisposition; baseHash?: string | null; localHash?: string | null; remoteHash?: string | null },
): Promise<void> {
  if (!runId) return;
  await recordUpgradeDetail(client, dialect, runId, {
    family: d.family, logicalKey: d.logicalKey, disposition: d.disposition,
    baseHash: d.baseHash, localHash: d.localHash, remoteHash: d.remoteHash,
  });
}

/**
 * Give every GLOBAL row of a family a baseline (a realm_versions entry + origin_hash) if it has none —
 * self-healing so a built-in seeded by any path becomes "managed" and drift is always measured against a
 * real baseline. Idempotent: only fills gaps, using the row's current content as the baseline.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param spec the family's registry entry.
 * @param opts timestamp stamp.
 */
export async function ensureFamilyBaselines(client: SqlClient, dialect: SqlDialect, spec: RealmFamilySpec, opts: { at?: string } = {}): Promise<void> {
  const log = createSqlVersionLog<Record<string, unknown>>({ client, dialect, table: 'realm_versions' });
  const have = await log.latestAll(spec.family);
  const { rows } = await client.query(`SELECT * FROM ${spec.table} WHERE realm = 'global'`);
  for (const row of rows) {
    const lk = logicalKeyOfRow(spec, row);
    if (!lk) continue;
    const live = hashRowLive(spec, row);
    // Rows seeded AFTER their migration ran keep logical_key/content_hash unset (the ledgered runner no
    // longer re-backfills them), so the reconcile is the authoritative populator of both. Idempotent.
    if (!(row['logical_key'] as string | null)) {
      await client.query(`UPDATE ${spec.table} SET logical_key = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [lk, String(row['id'])]);
    }
    if (!(row['content_hash'] as string | null)) {
      await client.query(`UPDATE ${spec.table} SET content_hash = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [live, String(row['id'])]);
    }
    if (have.has(lk)) continue;
    await log.append({ family: spec.family, logicalKey: lk, payload: semanticOf(spec, row), at: opts.at, note: 'baseline' });
    if (!(row['origin_hash'] as string | null)) {
      await client.query(`UPDATE ${spec.table} SET origin_hash = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [live, String(row['id'])]);
    }
  }
}

/** A provider of a family's shipped defaults (row-shaped). Absent families get baseline-only treatment. */
export type RealmSeedDefaults = Partial<Record<string, ReadonlyArray<RealmDefault>>>;

/** Aggregate outcome of a whole-registry reconcile. */
export interface AllFamiliesReconcileResult {
  readonly runId?: string;
  readonly perFamily: FamilyReconcileResult[];
  /** Total counts by disposition across families. */
  readonly summary: Record<string, number>;
}

/**
 * Reconcile EVERY registered family. For a family with provided `defaults`, runs the full reconcile
 * (publish + adopt-stale-per-policy + review). For a family without provided defaults, still ensures
 * baselines exist so the family participates in drift going forward (the Remote leg starts populated on
 * the next release once its defaults are wired). This is the boot-time step that closes the L4 loop.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param defaultsByFamily shipped defaults keyed by family string (missing families → baseline-only).
 * @param opts an optional run id (to record every touched record), timestamps, and per-family policy map.
 * @returns per-family results + a combined summary. Side effects as {@link reconcileRealmFamily}.
 */
export async function reconcileAllRealmFamilies(
  client: SqlClient,
  dialect: SqlDialect,
  defaultsByFamily: RealmSeedDefaults,
  opts: { runId?: string; at?: string; publishedBy?: string; policyByFamily?: Readonly<Record<string, AutoAdoptPolicy>> } = {},
): Promise<AllFamiliesReconcileResult> {
  const perFamily: FamilyReconcileResult[] = [];
  const summary: Record<string, number> = {};
  for (const spec of Object.values(REALM_FAMILIES)) {
    const defaults = defaultsByFamily[spec.family];
    if (defaults && defaults.length > 0) {
      const res = await reconcileRealmFamily(client, dialect, spec, defaults, {
        runId: opts.runId, at: opts.at, publishedBy: opts.publishedBy,
        policy: opts.policyByFamily?.[spec.family],
      });
      perFamily.push(res);
      summary['adopted'] = (summary['adopted'] ?? 0) + res.adopted.length;
      summary['published'] = (summary['published'] ?? 0) + res.published.length;
      for (const r of res.review) summary[r.state] = (summary[r.state] ?? 0) + 1;
    } else {
      // No shipped defaults wired for this family yet → keep it drift-ready via baselines only.
      await ensureFamilyBaselines(client, dialect, spec, { at: opts.at });
      perFamily.push({ family: spec.family, adopted: [], published: [], review: [] });
    }
  }
  return { runId: opts.runId, perFamily, summary };
}

/**
 * The boot-time seed-reconcile step, wrapped in a persisted upgrade run. Opens an `upgrade_runs` row
 * (mode 'seed_reconcile'), reconciles the whole registry recording every touched record under it, then
 * closes the run 'succeeded' (or 'succeeded_with_pending' if anything needs review). Safe to call every
 * boot: on a fresh install everything is new/in_sync and it just publishes baselines; on an upgrade it
 * adopts the untouched changes and flags the rest. Never throws for a review item — reconcile is
 * non-blocking by design.
 *
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param defaults the release's shipped defaults keyed by family (see collectRealmSeedDefaults).
 * @param opts optional release version (stamped on the run) and timestamp.
 * @returns the run id and the per-family reconcile result.
 */
export async function performSeedReconcile(
  client: SqlClient,
  dialect: SqlDialect,
  defaults: RealmSeedDefaults,
  opts: { toVersion?: string | null; at?: string; publishedBy?: string } = {},
): Promise<{ runId: string; result: AllFamiliesReconcileResult }> {
  const runId = await beginUpgradeRun(client, dialect, { mode: 'seed_reconcile', toVersion: opts.toVersion ?? null, at: opts.at });
  const result = await reconcileAllRealmFamilies(client, dialect, defaults, { runId, at: opts.at, publishedBy: opts.publishedBy });
  const reviewCount = result.perFamily.reduce((n, f) => n + f.review.length, 0);
  await finishUpgradeRun(client, dialect, runId, {
    status: reviewCount > 0 ? 'succeeded_with_pending' : 'succeeded',
    summary: result.summary,
    at: opts.at,
  });
  return { runId, result };
}

/** True if a review disposition needs a human (re-exported for callers building the queue). */
export { needsReview };
