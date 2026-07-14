// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — retention pruning for the `realm_versions` log.
 *
 * `realm_versions` is an append-only, content-addressed log: every published default for a `(family,
 * logical_key)` lands one immutable row (drift's Base/Remote payloads live here). Content-addressing keeps it
 * naturally deduped, but a long-lived instance that ships many releases still accumulates historical payloads
 * for records nobody references any more. This is the safe garbage collector for that tail.
 *
 * The version log (`@weaveintel/realm`'s `createSqlVersionLog`) is append + read only — it has NO delete — so
 * pruning reaches the table directly with a carefully-guarded `DELETE`. The guard is a **keep-set** computed
 * per `(family, logical_key)`; a version row is deleted only if it is in NONE of these:
 *
 *   1. **The head, and the newest `keepPerKey` versions.** The latest version is the Remote leg every drift/
 *      diff/reconcile reads (`log.latest`/`latestAll`); deleting it would destroy the baseline. We keep a small
 *      window beyond the head so recent history (revert targets) survives.
 *   2. **Live-referenced payloads.** A live row's `origin_hash` (its fork/baseline) or `content_hash` points
 *      into `realm_versions.content_hash` (the `versionPayloadByHash` lookup). Any version whose `content_hash`
 *      a live row still references is a Base someone needs — never prune it.
 *   3. **Pinned versions.** A tenant can pin a specific version number (`realm_tenant_state.pinned_version`);
 *      `resolvePinnedVersions` serves the pinned payload by number. Deleting a pinned version would silently
 *      drop the tenant back to the current default — exactly the failure the pin exists to prevent. Every
 *      pinned version number for the key is kept, however old.
 *
 * Engine-agnostic over the `SqlClient` / `SqlDialect` seam (SQLite + Postgres). All SQL is parameterized.
 * Idempotent: re-running after a prune deletes nothing new. Read-mostly + bounded-memory (processes one family
 * at a time; the per-family working sets are the live-hash set, the pin set, and the family's version rows).
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph } from './realm-sql.js';
import { REALM_FAMILIES, realmFamily, type RealmFamilySpec } from './realm-families.js';
import { recordUpgradeTelemetry } from './upgrade-telemetry.js';

/** How many newest versions to keep per key regardless of references (must be ≥ 1 so the head is safe). */
const DEFAULT_KEEP_PER_KEY = 10;
/** Batch size for the DELETE ... WHERE id IN (...) statements (bounded to keep the bind list small). */
const DELETE_BATCH = 200;

/** What a prune pass did, overall and (optionally) per family. */
export interface PruneResult {
  /** Version rows examined across all processed families. */
  readonly examined: number;
  /** Version rows deleted — or, on a dry run, the number that WOULD be deleted (the plan). */
  readonly deleted: number;
  /** Version rows kept (head-window ∪ live-referenced ∪ pinned). */
  readonly kept: number;
  /** Per-family { family, examined, deleted, kept } (in registry order). */
  readonly perFamily: ReadonlyArray<{ family: string; examined: number; deleted: number; kept: number }>;
  /** True when nothing was actually deleted because `dryRun` was set. */
  readonly dryRun: boolean;
}

/** A version row the prune pass reasons over. */
interface VersionRow { id: string; logical_key: string; version: number; content_hash: string }

/**
 * The set of `content_hash` values a family's LIVE rows still reference (their `origin_hash` = the Base a fork
 * was taken from, and their current `content_hash`). A version whose hash is in this set is a payload someone
 * can still diff against and must be kept.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param spec the family's registry entry (its `table`).
 * @returns a Set of referenced content-hash strings.
 */
async function liveReferencedHashes(client: SqlClient, dialect: SqlDialect, spec: RealmFamilySpec): Promise<Set<string>> {
  const out = new Set<string>();
  // Every live row (global + tenant forks): its content_hash (current) and origin_hash (the version it was
  // forked/baselined from). Both may point into realm_versions.content_hash and must survive a prune.
  const { rows } = await client.query(`SELECT origin_hash, content_hash FROM ${spec.table}`, []);
  for (const r of rows as Array<Record<string, unknown>>) {
    const oh = r['origin_hash']; if (typeof oh === 'string' && oh) out.add(oh);
    const ch = r['content_hash']; if (typeof ch === 'string' && ch) out.add(ch);
  }
  return out;
}

/**
 * The set of pinned version NUMBERS per logical key for a family, across ALL tenants — every version a pin
 * still names must survive, however old.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param family the realm family string.
 * @returns a Map of logicalKey → Set of pinned version numbers.
 */
async function pinnedVersionsByKey(client: SqlClient, dialect: SqlDialect, family: string): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  const { rows } = await client.query(
    `SELECT DISTINCT logical_key, pinned_version FROM realm_tenant_state WHERE family = ${ph(dialect, 1)} AND pinned_version IS NOT NULL`,
    [family],
  );
  for (const r of rows as Array<Record<string, unknown>>) {
    const key = String(r['logical_key'] ?? '');
    const v = Number(r['pinned_version']);
    if (!key || !Number.isInteger(v)) continue;
    let set = out.get(key);
    if (!set) { set = new Set<number>(); out.set(key, set); }
    set.add(v);
  }
  return out;
}

/** Delete version rows by id in bounded batches (parameterized IN list). Returns the count deleted. */
async function deleteByIds(client: SqlClient, dialect: SqlDialect, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH);
    const placeholders = batch.map((_, j) => ph(dialect, j + 1)).join(', ');
    await client.query(`DELETE FROM realm_versions WHERE id IN (${placeholders})`, batch);
    deleted += batch.length;
  }
  return deleted;
}

/**
 * Prune one family's version log down to the keep-set (head window ∪ live-referenced ∪ pinned).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param spec the family's registry entry.
 * @param keepPerKey how many newest versions to keep per key (≥ 1).
 * @param dryRun when true, computes the plan but deletes nothing.
 * @returns per-family counts. Side effect: deletes stale version rows unless dryRun.
 */
async function pruneFamily(
  client: SqlClient, dialect: SqlDialect, spec: RealmFamilySpec, keepPerKey: number, dryRun: boolean,
): Promise<{ family: string; examined: number; deleted: number; kept: number }> {
  const [liveHashes, pins] = await Promise.all([
    liveReferencedHashes(client, dialect, spec),
    pinnedVersionsByKey(client, dialect, spec.family),
  ]);
  // Version rows newest-first per key, so the first `keepPerKey` per key are the head window.
  const { rows } = await client.query(
    `SELECT id, logical_key, version, content_hash FROM realm_versions WHERE family = ${ph(dialect, 1)} ORDER BY logical_key ASC, version DESC`,
    [spec.family],
  );
  const versions = rows as unknown as VersionRow[];

  const deletable: string[] = [];
  let kept = 0;
  let currentKey = '';
  let seenForKey = 0;
  for (const v of versions) {
    if (v.logical_key !== currentKey) { currentKey = v.logical_key; seenForKey = 0; }
    seenForKey++;
    const inHeadWindow = seenForKey <= keepPerKey;                 // head + retention window
    const isPinned = pins.get(v.logical_key)?.has(v.version) ?? false;
    const isReferenced = !!v.content_hash && liveHashes.has(v.content_hash);
    if (inHeadWindow || isPinned || isReferenced) { kept++; continue; }
    deletable.push(v.id);
  }

  // On a dry run, report the PLAN (how many WOULD be deleted) without touching the table.
  const deleted = dryRun ? deletable.length : await deleteByIds(client, dialect, deletable);
  return { family: spec.family, examined: versions.length, deleted, kept };
}

/**
 * Prune the `realm_versions` log across families, keeping every version that is the head/recent, live-
 * referenced, or pinned. Safe to run periodically or after an upgrade to bound version-log growth.
 *
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param opts.keepPerKey newest versions to keep per key (default 10; clamped to ≥ 1 so the head is never lost).
 * @param opts.family restrict to one realm family (must be registered); omit to prune every registered family.
 * @param opts.dryRun compute the plan without deleting (returns what WOULD be pruned).
 * @returns aggregate + per-family counts. Side effect: deletes stale version rows unless dryRun.
 * @throws if `opts.family` names an unregistered family (a typo shouldn't silently prune nothing).
 */
export async function pruneRealmVersions(
  client: SqlClient, dialect: SqlDialect,
  opts: { keepPerKey?: number; family?: string; dryRun?: boolean } = {},
): Promise<PruneResult> {
  const keepPerKey = Math.max(1, Math.floor(opts.keepPerKey ?? DEFAULT_KEEP_PER_KEY));
  const dryRun = opts.dryRun ?? false;
  const specs = opts.family ? [realmFamily(opts.family)] : Object.values(REALM_FAMILIES);

  const perFamily: Array<{ family: string; examined: number; deleted: number; kept: number }> = [];
  let examined = 0, deleted = 0, kept = 0;
  for (const spec of specs) {
    const r = await pruneFamily(client, dialect, spec, keepPerKey, dryRun);
    perFamily.push(r);
    examined += r.examined; deleted += r.deleted; kept += r.kept;
  }
  // A real prune (not a dry run) is an operational event worth an aggregate, PII-free telemetry breadcrumb.
  if (!dryRun) await recordUpgradeTelemetry(client, dialect, 'prune', { counts: { examined, deleted, kept } });
  return { examined, deleted, kept, perFamily, dryRun };
}
