// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — durable persistence for upgrade runs and their per-record outcomes.
 *
 * Every reconcile/preview/apply pass opens an `upgrade_runs` row and, as it classifies each shipped
 * default, writes an `upgrade_details` row: what the record is (family + logical key), what the pass
 * decided (disposition), how urgent the leftover is (priority band, from {@link upgradePriority}), and the
 * three content hashes the diff/merge workbench needs. When the pass ends it stamps the run's status and a
 * summary count. The review queue, propagation, and the Upgrade Center all read these rows — this is the
 * single source of truth for "what did the last upgrade do, and what still needs me".
 *
 * Written once against the framework's `SqlClient` seam (with the shared `ph`/`nowExpr` dialect helpers)
 * so it serves both SQLite (`sqliteSqlClient`) and Postgres (the pg ctx) with no per-engine copy. The
 * tables are created by m163 (SQLite) / the regenerated schema (Postgres).
 */
import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';
import { upgradePriority, type UpgradeDisposition, type UpgradePriority } from './upgrade-priority.js';

/** How a run was invoked. `seed_reconcile` is the boot-time reconcile; the others are the CLI/route flow. */
export type UpgradeRunMode = 'seed_reconcile' | 'preview' | 'apply';
/** Terminal + in-flight run states. `succeeded_with_pending` = applied cleanly but left review items. */
export type UpgradeRunStatus = 'running' | 'succeeded' | 'succeeded_with_pending' | 'failed' | 'rolled_back';

/** Options when opening a run. */
export interface BeginUpgradeRunOptions {
  readonly mode: UpgradeRunMode;
  readonly fromVersion?: string | null;
  readonly toVersion?: string | null;
  /** ISO timestamp override (tests / deterministic replay). Defaults to the DB clock. */
  readonly at?: string;
}

/** One record's outcome, as handed to {@link recordUpgradeDetail} (priority is derived, not passed). */
export interface UpgradeDetailInput {
  readonly family: string;
  readonly logicalKey: string;
  readonly disposition: UpgradeDisposition;
  /** Upgrade layer this belongs to; defaults to 'L4' (seeded data). */
  readonly layer?: string;
  readonly baseHash?: string | null;
  readonly localHash?: string | null;
  readonly remoteHash?: string | null;
  readonly note?: string | null;
  /** Override the derived priority (rare; e.g. a manifest marks a record P1). */
  readonly priority?: UpgradePriority;
}

/** A persisted upgrade_details row (read shape). */
export interface UpgradeDetailRow {
  id: string;
  run_id: string;
  family: string;
  logical_key: string;
  layer: string;
  disposition: string;
  priority: string;
  base_hash: string | null;
  local_hash: string | null;
  remote_hash: string | null;
  note: string | null;
  resolution: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  /** Provenance of the resolution: null = interactive, 'automation' = a rule, 'imported' = a bundle. */
  resolution_source: string | null;
  /** Captured pre-action state for an undoable 'adopted' resolution (JSON); null for keep/defer. */
  undo_json: string | null;
  created_at: string;
}

/**
 * Open a new upgrade run in status 'running' and return its id.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param opts run mode + optional version span + timestamp override.
 * @returns the new run's id (a UUID). Side effect: one INSERT into upgrade_runs.
 */
export async function beginUpgradeRun(client: SqlClient, dialect: SqlDialect, opts: BeginUpgradeRunOptions): Promise<string> {
  const id = randomUUID();
  const at = opts.at ?? null;
  await client.query(
    `INSERT INTO upgrade_runs (id, mode, status, from_version, to_version, dialect, summary_json, started_at)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, 'running', ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, '{}', COALESCE(${ph(dialect, 6)}, ${nowExpr(dialect)}))`,
    [id, opts.mode, opts.fromVersion ?? null, opts.toVersion ?? null, dialect, at],
  );
  return id;
}

/**
 * Record one record's outcome under a run. The priority band is derived from (family, disposition) via
 * {@link upgradePriority} unless explicitly overridden — a collision/conflict is always P1.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the owning run's id.
 * @param d the record's family, logical key, disposition, and (optional) hashes/note/priority.
 * @returns nothing. Side effect: one INSERT into upgrade_details.
 */
export async function recordUpgradeDetail(client: SqlClient, dialect: SqlDialect, runId: string, d: UpgradeDetailInput): Promise<void> {
  const priority = d.priority ?? upgradePriority(d.family, d.disposition);
  await client.query(
    `INSERT INTO upgrade_details (id, run_id, family, logical_key, layer, disposition, priority, base_hash, local_hash, remote_hash, note, created_at)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, ${ph(dialect, 7)}, ${ph(dialect, 8)}, ${ph(dialect, 9)}, ${ph(dialect, 10)}, ${ph(dialect, 11)}, ${nowExpr(dialect)})`,
    [randomUUID(), runId, d.family, d.logicalKey, d.layer ?? 'L4', d.disposition, priority, d.baseHash ?? null, d.localHash ?? null, d.remoteHash ?? null, d.note ?? null],
  );
}

/**
 * Close a run: stamp its final status, a summary count (by disposition), and finished_at.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the run to finish.
 * @param opts final status, the summary object (serialised to summary_json), and timestamp override.
 * @returns nothing. Side effect: one UPDATE of upgrade_runs.
 */
export async function finishUpgradeRun(
  client: SqlClient,
  dialect: SqlDialect,
  runId: string,
  opts: { status: UpgradeRunStatus; summary?: Record<string, number>; at?: string },
): Promise<void> {
  await client.query(
    `UPDATE upgrade_runs SET status = ${ph(dialect, 1)}, summary_json = ${ph(dialect, 2)}, finished_at = COALESCE(${ph(dialect, 3)}, ${nowExpr(dialect)}) WHERE id = ${ph(dialect, 4)}`,
    [opts.status, JSON.stringify(opts.summary ?? {}), opts.at ?? null, runId],
  );
}

/**
 * List the detail rows for a run, most-urgent first (P1→P5), then newest.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the run whose details to list.
 * @param filter optional narrowing by family / disposition / priority.
 * @returns the matching detail rows.
 */
export async function listUpgradeDetails(
  client: SqlClient,
  dialect: SqlDialect,
  runId: string,
  filter: { family?: string; disposition?: string; priority?: string } = {},
): Promise<UpgradeDetailRow[]> {
  const where: string[] = [`run_id = ${ph(dialect, 1)}`];
  const params: unknown[] = [runId];
  if (filter.family) { params.push(filter.family); where.push(`family = ${ph(dialect, params.length)}`); }
  if (filter.disposition) { params.push(filter.disposition); where.push(`disposition = ${ph(dialect, params.length)}`); }
  if (filter.priority) { params.push(filter.priority); where.push(`priority = ${ph(dialect, params.length)}`); }
  const { rows } = await client.query(
    `SELECT * FROM upgrade_details WHERE ${where.join(' AND ')} ORDER BY priority ASC, created_at DESC, id DESC`,
    params,
  );
  return rows as unknown as UpgradeDetailRow[];
}

/**
 * The review queue: every UNRESOLVED detail across all runs, most-urgent first (P1→P5, then newest). Optional
 * narrowing by family / priority. This is what the Upgrade Center's review queue lists.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param filter optional { family, priority } narrowing.
 * @returns the unresolved detail rows.
 */
export async function listUnresolvedUpgradeDetails(
  client: SqlClient,
  dialect: SqlDialect,
  filter: { family?: string; priority?: string } = {},
): Promise<UpgradeDetailRow[]> {
  const where: string[] = ['resolution IS NULL'];
  const params: unknown[] = [];
  if (filter.family) { params.push(filter.family); where.push(`family = ${ph(dialect, params.length)}`); }
  if (filter.priority) { params.push(filter.priority); where.push(`priority = ${ph(dialect, params.length)}`); }
  const { rows } = await client.query(
    `SELECT * FROM upgrade_details WHERE ${where.join(' AND ')} ORDER BY priority ASC, created_at DESC, id DESC`,
    params,
  );
  return rows as unknown as UpgradeDetailRow[];
}

/**
 * Fetch one detail row by id.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the row id.
 * @returns the row, or null if not found.
 */
export async function getUpgradeDetail(client: SqlClient, dialect: SqlDialect, detailId: string): Promise<UpgradeDetailRow | null> {
  const { rows } = await client.query(`SELECT * FROM upgrade_details WHERE id = ${ph(dialect, 1)}`, [detailId]);
  return (rows[0] as unknown as UpgradeDetailRow) ?? null;
}

/**
 * Re-open a previously-resolved detail (the review-queue UNDO): clears resolution, resolver, and the captured
 * undo state so it returns to the queue.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the row id.
 * @returns nothing. Side effect: one UPDATE of upgrade_details.
 */
export async function unresolveUpgradeDetail(client: SqlClient, dialect: SqlDialect, detailId: string): Promise<void> {
  await client.query(
    `UPDATE upgrade_details SET resolution = NULL, resolved_at = NULL, resolved_by = NULL, resolution_source = NULL, undo_json = NULL WHERE id = ${ph(dialect, 1)}`,
    [detailId],
  );
}

/**
 * Store the captured pre-action state on a detail (so an 'adopted' resolution can be undone).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the row id.
 * @param undoJson the serialised pre-action row state, or null.
 * @returns nothing. Side effect: one UPDATE of upgrade_details.
 */
export async function setUpgradeDetailUndo(client: SqlClient, dialect: SqlDialect, detailId: string, undoJson: string | null): Promise<void> {
  await client.query(`UPDATE upgrade_details SET undo_json = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [undoJson, detailId]);
}

/**
 * Mark a detail row resolved — the review-queue write path (keep-mine / adopt-incoming / merged / deferred).
 * A resolved P1 no longer blocks the next apply's `unresolved_p1` preflight gate. Idempotent by row id.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the upgrade_details row id to resolve.
 * @param opts.resolution how it was resolved (e.g. 'kept' | 'adopted' | 'merged' | 'deferred').
 * @param opts.resolvedBy who resolved it (a user id / 'automation'); optional.
 * @param opts.resolutionSource provenance of the resolution: null/omitted = interactive, 'automation' =
 *        a resolution rule, 'imported' = a signed resolution bundle. Recorded for audit.
 * @param opts.at ISO timestamp override (tests); defaults to the DB clock.
 * @returns nothing. Side effect: one UPDATE of upgrade_details.
 */
export async function resolveUpgradeDetail(
  client: SqlClient,
  dialect: SqlDialect,
  detailId: string,
  opts: { resolution: string; resolvedBy?: string | null; resolutionSource?: string | null; at?: string },
): Promise<void> {
  // Conditional on `resolution IS NULL`: the terminal write is a single-shot claim, so two concurrent resolves
  // of the same item can't both land (the loser's UPDATE matches no row). Callers pre-check too; this closes the
  // read-check-write window between them.
  await client.query(
    `UPDATE upgrade_details SET resolution = ${ph(dialect, 1)}, resolved_by = ${ph(dialect, 2)}, resolution_source = ${ph(dialect, 3)}, resolved_at = COALESCE(${ph(dialect, 4)}, ${nowExpr(dialect)}) WHERE id = ${ph(dialect, 5)} AND resolution IS NULL`,
    [opts.resolution, opts.resolvedBy ?? null, opts.resolutionSource ?? null, opts.at ?? null, detailId],
  );
}

/** A persisted upgrade_runs row (read shape). */
export interface UpgradeRunRow {
  id: string;
  mode: string;
  status: string;
  from_version: string | null;
  to_version: string | null;
  dialect: string | null;
  summary_json: string;
  started_at: string;
  finished_at: string | null;
  /** Path of the retained pre-upgrade snapshot (for `rollback --run <id>`); null once discarded. */
  snapshot_ref: string | null;
}

/**
 * Record (or clear) the retained pre-upgrade snapshot path for a run.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the run to stamp.
 * @param ref the snapshot artifact path, or null to clear it (after the snapshot is discarded).
 * @returns nothing. Side effect: one UPDATE of upgrade_runs.
 */
export async function setRunSnapshotRef(client: SqlClient, dialect: SqlDialect, runId: string, ref: string | null): Promise<void> {
  await client.query(`UPDATE upgrade_runs SET snapshot_ref = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [ref, runId]);
}

/**
 * Fetch one run by id.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the run id.
 * @returns the run row, or null if not found.
 */
export async function getUpgradeRun(client: SqlClient, dialect: SqlDialect, runId: string): Promise<UpgradeRunRow | null> {
  const { rows } = await client.query(`SELECT * FROM upgrade_runs WHERE id = ${ph(dialect, 1)}`, [runId]);
  return (rows[0] as unknown as UpgradeRunRow) ?? null;
}

/**
 * List runs that still hold a retained snapshot (a non-null snapshot_ref), optionally excluding one run —
 * the input to bounded retention (discard every older snapshot, keep the newest).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param exceptRunId a run id to exclude (the one being kept); optional.
 * @returns `{ id, snapshot_ref }` for each retained run.
 */
export async function listRetainedSnapshots(
  client: SqlClient,
  dialect: SqlDialect,
  exceptRunId?: string,
): Promise<Array<{ id: string; snapshot_ref: string }>> {
  const where = exceptRunId ? ` AND id != ${ph(dialect, 1)}` : '';
  const { rows } = await client.query(
    `SELECT id, snapshot_ref FROM upgrade_runs WHERE snapshot_ref IS NOT NULL${where}`,
    exceptRunId ? [exceptRunId] : [],
  );
  return rows as unknown as Array<{ id: string; snapshot_ref: string }>;
}

/**
 * Fetch the most recent run (optionally of a given mode).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param mode optional mode filter.
 * @returns the newest matching run row, or null if none.
 */
export async function latestUpgradeRun(client: SqlClient, dialect: SqlDialect, mode?: UpgradeRunMode): Promise<UpgradeRunRow | null> {
  const where = mode ? `WHERE mode = ${ph(dialect, 1)}` : '';
  const { rows } = await client.query(
    `SELECT * FROM upgrade_runs ${where} ORDER BY started_at DESC, id DESC LIMIT 1`,
    mode ? [mode] : [],
  );
  return (rows[0] as unknown as UpgradeRunRow) ?? null;
}
