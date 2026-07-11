// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — the diff / merge workbench (Section E, item 18).
 *
 * Drift already told you a record was `diverged` — *both* you and upstream changed it since you forked.
 * It could not tell you WHAT changed, and the only remedy was `resync`, which throws your edit away and
 * takes the shipped version wholesale. This turns that into a real three-way merge, field by field:
 *
 *   BASE   — the content you forked from (`origin_hash` → the matching `realm_versions` payload)
 *   LOCAL  — your current content (the row's own semantic columns)
 *   REMOTE — the latest published default (`realm_versions` latest, else the live global row)
 *
 * which is exactly git's merge, applied to config. Fields only you touched keep your value; fields only
 * upstream touched adopt theirs; fields you BOTH touched are **conflicts** a human resolves. Everything
 * is generic over the family registry, so all eleven families get this from one implementation.
 *
 * BASE is recoverable only if the version you forked from was ever published to the log. When it wasn't,
 * we say so honestly (`baseAvailable: false`) and degrade to a two-way diff — LOCAL vs REMOTE, where
 * every difference is a conflict, because without a base we cannot know who moved.
 */
import { createSqlVersionLog, driftState, type SqlClient, type SqlDialect, type DriftState } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { realmFamily, logicalKeyOfRow, type RealmFamilySpec } from './realm-families.js';

const ph = (d: SqlDialect, i: number) => (d === 'postgres' ? `$${i}` : '?');

export type Payload = Record<string, unknown>;

/** How one field moved between BASE, LOCAL and REMOTE. */
export type FieldStatus =
  | 'unchanged'      // nobody touched it
  | 'local_only'     // only you changed it   → keep yours
  | 'remote_only'    // only upstream changed → adopt theirs
  | 'both_same'      // you both made the same change → no conflict
  | 'conflict';      // you both changed it differently → a human decides

export interface FieldDiff {
  readonly field: string;
  readonly base: unknown;
  readonly local: unknown;
  readonly remote: unknown;
  readonly status: FieldStatus;
  /** What an auto-merge would take for this field. Absent for a conflict — that is the point. */
  readonly resolved?: unknown;
}

export interface ThreeWayDiff {
  readonly family: string;
  readonly recordId: string;
  readonly logicalKey: string;
  /** `global` | `tenant` — so a caller can authorize without a second query. */
  readonly realm: string;
  /** The owning tenant of a fork; null for a global default. */
  readonly ownerTenantId: string | null;
  readonly drift: DriftState | 'not_a_fork';
  /** False when the forked-from version was never published — then every difference reads as a conflict. */
  readonly baseAvailable: boolean;
  readonly fields: readonly FieldDiff[];
  readonly conflicts: readonly string[];
  /** The hashes drift is computed from, for display/debug. */
  readonly hashes: { base: string | null; local: string; remote: string | null };
}

/** Value equality over semantic payloads — canonical, so key order and JSON-vs-object never lie. */
const same = (a: unknown, b: unknown): boolean => realmContentHash({ v: a ?? null }) === realmContentHash({ v: b ?? null });

/** Project a raw DB row onto the family's semantic fields (the same projection the hash uses). */
export function semanticOfRow(spec: RealmFamilySpec, row: Payload): Payload {
  const out: Payload = {};
  for (const c of spec.semanticCols) out[c] = parseRealmSemantic(row[c]);
  return out;
}

// ════════════════════════════ the pure merge ════════════════════════════

/**
 * Compare three payloads field by field. With no BASE (`baseAvailable: false`) we cannot attribute a
 * change to either side, so any difference between LOCAL and REMOTE is reported as a conflict rather
 * than silently guessing — refusing to guess is the whole value of a merge tool.
 */
export function threeWayFieldDiff(
  spec: RealmFamilySpec, base: Payload | null, local: Payload, remote: Payload | null,
): { fields: FieldDiff[]; conflicts: string[] } {
  const fields: FieldDiff[] = [];
  const conflicts: string[] = [];

  for (const field of spec.semanticCols) {
    const l = local[field] ?? null;
    const r = remote ? (remote[field] ?? null) : null;
    const b = base ? (base[field] ?? null) : null;

    if (!remote) { // nothing to merge against — everything is simply yours
      fields.push({ field, base: b, local: l, remote: null, status: 'unchanged', resolved: l });
      continue;
    }
    if (!base) { // two-way: we cannot tell who moved
      if (same(l, r)) fields.push({ field, base: null, local: l, remote: r, status: 'unchanged', resolved: l });
      else { fields.push({ field, base: null, local: l, remote: r, status: 'conflict' }); conflicts.push(field); }
      continue;
    }

    const localChanged = !same(l, b);
    const remoteChanged = !same(r, b);
    if (!localChanged && !remoteChanged) fields.push({ field, base: b, local: l, remote: r, status: 'unchanged', resolved: l });
    else if (localChanged && !remoteChanged) fields.push({ field, base: b, local: l, remote: r, status: 'local_only', resolved: l });
    else if (!localChanged && remoteChanged) fields.push({ field, base: b, local: l, remote: r, status: 'remote_only', resolved: r });
    else if (same(l, r)) fields.push({ field, base: b, local: l, remote: r, status: 'both_same', resolved: l });
    else { fields.push({ field, base: b, local: l, remote: r, status: 'conflict' }); conflicts.push(field); }
  }
  return { fields, conflicts };
}

/**
 * The payload an auto-merge produces: every non-conflicting field resolved. Conflicting fields keep the
 * LOCAL value as a placeholder and are listed in `conflicts` — a caller must not apply a merge with
 * unresolved conflicts without an explicit human choice (see `applyRealmMerge`).
 */
export function autoMerge(
  diff: ThreeWayDiff,
  structured?: Record<string, (base: unknown, local: unknown, remote: unknown) => { value: unknown; conflicts: string[] }>,
): { merged: Payload; conflicts: string[] } {
  const merged: Payload = {};
  const conflicts: string[] = [];
  for (const f of diff.fields) {
    // A structured field (e.g. a workflow's node graph) that conflicts atomically is re-merged element by
    // element: the non-conflicting elements resolve, and only genuinely-conflicting elements remain — so a
    // vendor-added node and a tenant re-wiring coexist instead of the whole field reading as one conflict.
    const sm = structured?.[f.field];
    if (sm && f.status === 'conflict') {
      const res = sm(f.base, f.local, f.remote);
      merged[f.field] = res.value;
      if (res.conflicts.length > 0) conflicts.push(f.field);
      continue;
    }
    if (f.status === 'conflict') { merged[f.field] = f.local; conflicts.push(f.field); }
    else merged[f.field] = f.resolved;
  }
  return { merged, conflicts };
}

// ════════════════════════════ loading the three payloads ════════════════════════════

async function rowById(client: SqlClient, dialect: SqlDialect, table: string, id: string): Promise<Payload | null> {
  const { rows } = await client.query(`SELECT * FROM ${table} WHERE id = ${ph(dialect, 1)}`, [id]);
  return (rows[0] as Payload | undefined) ?? null;
}

/**
 * The payload of the published version whose content hash is `contentHash` — i.e. "what did this record
 * look like when it was forked". One indexed lookup (m161). Null when that version was never published.
 */
export async function versionPayloadByHash(
  client: SqlClient, dialect: SqlDialect, family: string, logicalKey: string, contentHash: string | null,
): Promise<Payload | null> {
  if (!contentHash) return null;
  const { rows } = await client.query(
    `SELECT payload FROM realm_versions WHERE family = ${ph(dialect, 1)} AND logical_key = ${ph(dialect, 2)} AND content_hash = ${ph(dialect, 3)} LIMIT 1`,
    [family, logicalKey, contentHash],
  );
  const raw = (rows[0] as { payload?: unknown } | undefined)?.payload;
  if (raw == null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Payload;
}

/**
 * Build the three-way diff for one record.
 *
 * REMOTE is the record's *upstream*: for a tenant fork that is the global original it was forked from
 * (its `origin_id`); for a global original that has drifted from the shipped package default, it is the
 * latest published version. Both cases reduce to "the content this record is supposed to track".
 */
export async function loadThreeWayDiff(
  client: SqlClient, dialect: SqlDialect, family: string, recordId: string,
): Promise<ThreeWayDiff | { error: string }> {
  const spec = realmFamily(family);
  const row = await rowById(client, dialect, spec.table, recordId);
  if (!row) return { error: 'not found' };

  const logicalKey = logicalKeyOfRow(spec, row);
  const local = semanticOfRow(spec, row);
  const localHash = realmContentHash(local);
  const baseHash = (row['origin_hash'] as string | null) ?? null;

  // REMOTE: a fork tracks its origin row; a global tracks the latest published version.
  let remote: Payload | null = null;
  let remoteHash: string | null = null;
  const originId = row['origin_id'] as string | null;
  if (row['realm'] === 'tenant' && originId) {
    const originRow = await rowById(client, dialect, spec.table, originId);
    if (originRow) { remote = semanticOfRow(spec, originRow); remoteHash = realmContentHash(remote); }
  } else {
    const log = createSqlVersionLog<Payload>({ client, dialect, table: 'realm_versions' });
    const latest = await log.latest(family, logicalKey);
    if (latest) { remote = latest.payload; remoteHash = latest.contentHash; }
  }

  const base = await versionPayloadByHash(client, dialect, family, logicalKey, baseHash);
  const { fields, conflicts } = threeWayFieldDiff(spec, base, local, remote);

  return {
    family: spec.family, recordId, logicalKey,
    realm: String(row['realm'] ?? 'global'),
    ownerTenantId: (row['owner_tenant_id'] as string | null) ?? null,
    drift: driftState(baseHash, localHash, remoteHash),
    baseAvailable: base !== null,
    fields, conflicts,
    hashes: { base: baseHash, local: localHash, remote: remoteHash },
  };
}

// ════════════════════════════ applying a merge ════════════════════════════

export interface MergeResult { ok: boolean; reason?: string; contentHash?: string; drift?: DriftState | 'not_a_fork' }

/**
 * Write a resolved merge onto the record and RE-BASELINE it: the merged content becomes `content_hash`
 * and the upstream content becomes the new `origin_hash`. Drift therefore settles to `in_sync` when the
 * merge equals upstream, or `customized` when the operator kept edits of their own — never `diverged`,
 * which is the point of merging.
 *
 * `resolved` supplies a value for every field the caller wishes to set. A merge is REFUSED while any
 * conflict is unresolved: silently picking a side is exactly the failure a merge tool exists to prevent.
 */
export async function applyRealmMerge(
  client: SqlClient, dialect: SqlDialect, family: string, recordId: string, resolved: Payload,
): Promise<MergeResult> {
  const spec = realmFamily(family);
  const diff = await loadThreeWayDiff(client, dialect, family, recordId);
  if ('error' in diff) return { ok: false, reason: diff.error };
  if (!diff.hashes.remote) return { ok: false, reason: 'nothing to merge against (no upstream version)' };

  const unresolved = diff.conflicts.filter((f) => !Object.hasOwn(resolved, f));
  if (unresolved.length > 0) {
    return { ok: false, reason: `unresolved conflicts: ${unresolved.join(', ')} — supply a value for each` };
  }

  // Start from the auto-merge, then let the caller's explicit choices win.
  const { merged } = autoMerge(diff);
  for (const field of spec.semanticCols) if (Object.hasOwn(resolved, field)) merged[field] = resolved[field];

  const contentHash = realmContentHash(merged);
  const sets = spec.semanticCols.map((c, i) => `${c} = ${ph(dialect, i + 1)}`);
  const vals: unknown[] = spec.semanticCols.map((c) => {
    const v = merged[c];
    return v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
  });
  sets.push(`content_hash = ${ph(dialect, vals.length + 1)}`); vals.push(contentHash);
  sets.push(`origin_hash = ${ph(dialect, vals.length + 1)}`); vals.push(diff.hashes.remote); // re-baseline
  vals.push(recordId);
  await client.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ${ph(dialect, vals.length)}`, vals);

  return { ok: true, contentHash, drift: driftState(diff.hashes.remote, contentHash, diff.hashes.remote) };
}

// ════════════════════════════ a drift report for EVERY family ════════════════════════════

export interface RealmDriftEntry {
  readonly id: string;
  readonly logicalKey: string;
  readonly realm: string;
  readonly ownerTenantId: string | null;
  readonly state: DriftState | 'not_a_fork';
  readonly base: string | null;
  readonly local: string;
  readonly remote: string | null;
}

export interface RealmDriftReport {
  readonly family: string;
  readonly entries: readonly RealmDriftEntry[];
  readonly summary: Record<string, number>;
}

/**
 * Which records in a family have drifted, and how. Generalises the prompts-only `promptDriftReport` to
 * every realm family AND to tenant forks (not just operator-edited globals): a fork's upstream is the
 * global it forked from, a global's upstream is the latest published version. `optsTenantId` narrows to
 * one tenant's forks; omit it for the whole family.
 */
export async function realmDriftReport(
  client: SqlClient, dialect: SqlDialect, family: string, opts: { tenantId?: string | null } = {},
): Promise<RealmDriftReport> {
  const spec = realmFamily(family);
  const { rows } = await client.query(`SELECT * FROM ${spec.table}`, []);
  const all = rows as unknown as Payload[];

  const log = createSqlVersionLog<Payload>({ client, dialect, table: 'realm_versions' });
  const latestByKey = await log.latestAll(family);
  const globalsById = new Map(all.filter((r) => r['realm'] !== 'tenant').map((r) => [String(r['id']), r]));

  const entries: RealmDriftEntry[] = [];
  const summary: Record<string, number> = {};
  for (const row of all) {
    const isTenant = row['realm'] === 'tenant';
    const owner = (row['owner_tenant_id'] as string | null) ?? null;
    if (opts.tenantId !== undefined && (!isTenant || owner !== opts.tenantId)) continue;

    const logicalKey = logicalKeyOfRow(spec, row);
    const local = realmContentHash(semanticOfRow(spec, row));
    const base = (row['origin_hash'] as string | null) ?? null;

    let remote: string | null = null;
    if (isTenant) {
      const origin = globalsById.get(String(row['origin_id'] ?? ''));
      remote = origin ? realmContentHash(semanticOfRow(spec, origin)) : null;
    } else {
      remote = latestByKey.get(logicalKey)?.contentHash ?? null;
    }

    const state = driftState(base, local, remote);
    summary[state] = (summary[state] ?? 0) + 1;
    entries.push({ id: String(row['id']), logicalKey, realm: String(row['realm'] ?? 'global'), ownerTenantId: owner, state, base, local, remote });
  }
  return { family: spec.family, entries, summary };
}
