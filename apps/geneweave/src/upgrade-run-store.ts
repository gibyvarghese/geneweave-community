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
