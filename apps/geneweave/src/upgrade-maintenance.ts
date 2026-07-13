// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the single-row MAINTENANCE flag (`upgrade_maintenance`, m171).
 *
 * The apply orchestrator raises maintenance while it mutates schema + content (the L1–L3 window) and clears
 * it in a `finally`. This module is the mechanism — set / clear / read — not the enforcement point: an edge
 * or middleware layer reads {@link isMaintenanceActive} to shed user traffic (503) while it's up.
 *
 * Written once against the framework's `SqlClient` seam (shared `ph`/`nowExpr`) so it serves SQLite and
 * Postgres with no per-engine copy.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';

/** The one maintenance row's fixed primary key. */
const ROW_ID = 'singleton';

/** The current maintenance state. */
export interface MaintenanceState {
  readonly active: boolean;
  readonly reason: string | null;
  readonly since: string | null;
}

/**
 * Read the current maintenance state.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @returns `{ active, reason, since }`; inactive (and null fields) when the row is absent.
 */
export async function maintenanceState(client: SqlClient, dialect: SqlDialect): Promise<MaintenanceState> {
  void dialect;
  const { rows } = await client.query(`SELECT active, reason, since FROM upgrade_maintenance WHERE id = '${ROW_ID}'`);
  const r = rows[0] as { active?: number | string; reason?: string | null; since?: string | null } | undefined;
  return { active: Number(r?.active ?? 0) === 1, reason: (r?.reason ?? null) || null, since: (r?.since ?? null) || null };
}

/** Convenience boolean read of {@link maintenanceState}. */
export async function isMaintenanceActive(client: SqlClient, dialect: SqlDialect): Promise<boolean> {
  return (await maintenanceState(client, dialect)).active;
}

/**
 * Raise the maintenance flag.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param reason a human reason (e.g. 'applying release 2.0.0').
 * @param at optional ISO timestamp override (tests). Defaults to the DB clock.
 * @returns nothing. Side effect: sets active = 1 on the singleton row.
 */
export async function setMaintenance(client: SqlClient, dialect: SqlDialect, reason: string, at?: string): Promise<void> {
  await client.query(
    `UPDATE upgrade_maintenance SET active = 1, reason = ${ph(dialect, 1)}, since = COALESCE(${ph(dialect, 2)}, ${nowExpr(dialect)}) WHERE id = '${ROW_ID}'`,
    [reason, at ?? null],
  );
}

/**
 * Clear the maintenance flag (idempotent — safe to call when already off).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns nothing. Side effect: sets active = 0 and clears reason/since.
 */
export async function clearMaintenance(client: SqlClient, dialect: SqlDialect): Promise<void> {
  await client.query(`UPDATE upgrade_maintenance SET active = 0, reason = NULL, since = NULL WHERE id = '${ROW_ID}'`);
}
