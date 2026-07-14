// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — local, PII-free upgrade-lifecycle telemetry.
 *
 * Records a compact operational event for each significant upgrade transition (a check outcome, an apply
 * result, a version-log prune) into the local `upgrade_telemetry` table (m176). It complements the detailed
 * `upgrade_runs` / `upgrade_details` ledger with a light, queryable stream an operator — or a local OTLP
 * collector — can trend over time.
 *
 * Privacy by construction:
 *   • Recording is gated by {@link telemetryEnabled} (honors DO_NOT_TRACK / GENEWEAVE_TELEMETRY); when opted
 *     out, `recordUpgradeTelemetry` is a no-op that writes nothing.
 *   • The event carries ONLY non-identifying operational facts — event name, outcome, edition, dialect, the
 *     release versions, and aggregate integer counts. There is no user id, key, path, or payload. `counts` is
 *     sanitized to a plain map of finite numbers before it is stored, so a caller can't accidentally leak an
 *     object/string into it.
 *   • Nothing is sent off the instance; it is a local INSERT.
 *
 * Engine-agnostic over the `SqlClient` / `SqlDialect` seam. All SQL is parameterized.
 */
import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';
import { telemetryEnabled } from './telemetry-config.js';

/** The lifecycle events the engine emits telemetry for. */
export type UpgradeTelemetryEvent = 'check' | 'apply' | 'verify' | 'rollback' | 'reconcile' | 'prune';

/** A recorded telemetry row (read shape). */
export interface UpgradeTelemetryRow {
  id: string;
  event: string;
  outcome: string | null;
  edition: string | null;
  dialect: string | null;
  from_version: string | null;
  to_version: string | null;
  counts_json: string | null;
  created_at: string;
}

/** The non-identifying facts a telemetry event may carry. */
export interface UpgradeTelemetryInput {
  readonly outcome?: string | null;
  readonly edition?: string | null;
  readonly fromVersion?: string | null;
  readonly toVersion?: string | null;
  /** Aggregate counts (e.g. { adopted, published, review, deleted }). Sanitized to finite numbers on write. */
  readonly counts?: Record<string, unknown>;
}

/** Keep only finite-number entries — a defensive filter so no object/string can ride into `counts_json`. */
function sanitizeCounts(counts: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!counts) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Record one upgrade-lifecycle telemetry event — a no-op when telemetry is opted out.
 *
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param event the lifecycle event.
 * @param input the non-identifying facts to record.
 * @param opts.env environment for the opt-out check (defaults to process.env; injectable for tests).
 * @param opts.at ISO timestamp override (tests); defaults to the DB clock.
 * @returns true if a row was written, false if telemetry was disabled (opted out). Never throws for a disabled
 *          instance; a write failure is swallowed (telemetry must never break an upgrade) and returns false.
 * @sideEffect one INSERT into upgrade_telemetry when enabled.
 */
export async function recordUpgradeTelemetry(
  client: SqlClient, dialect: SqlDialect, event: UpgradeTelemetryEvent, input: UpgradeTelemetryInput = {},
  opts: { env?: NodeJS.ProcessEnv; at?: string } = {},
): Promise<boolean> {
  if (!telemetryEnabled(opts.env ?? process.env)) return false;
  const counts = sanitizeCounts(input.counts);
  try {
    await client.query(
      `INSERT INTO upgrade_telemetry (id, event, outcome, edition, dialect, from_version, to_version, counts_json, created_at)
       VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, ${ph(dialect, 7)}, ${ph(dialect, 8)}, COALESCE(${ph(dialect, 9)}, ${nowExpr(dialect)}))`,
      [
        randomUUID(), event, input.outcome ?? null, input.edition ?? null, dialect,
        input.fromVersion ?? null, input.toVersion ?? null, counts ? JSON.stringify(counts) : null, opts.at ?? null,
      ],
    );
    return true;
  } catch {
    // Telemetry is best-effort observability; it must never take an upgrade down. Swallow and move on.
    return false;
  }
}

/**
 * Read recent telemetry events (newest first) — for an admin status view.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param opts.event optional event filter; opts.limit max rows (default 100).
 * @returns the rows, newest first.
 */
export async function listUpgradeTelemetry(
  client: SqlClient, dialect: SqlDialect, opts: { event?: string; limit?: number } = {},
): Promise<UpgradeTelemetryRow[]> {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
  const params: unknown[] = [];
  let where = '';
  if (opts.event) { params.push(opts.event); where = `WHERE event = ${ph(dialect, 1)}`; }
  const { rows } = await client.query(
    `SELECT * FROM upgrade_telemetry ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    params,
  );
  return rows as unknown as UpgradeTelemetryRow[];
}
