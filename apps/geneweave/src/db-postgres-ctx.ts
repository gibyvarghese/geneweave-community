// SPDX-License-Identifier: MIT
/**
 * Shared context for the per-domain Postgres stores. Each domain module (db-postgres/<domain>.ts) is
 * a factory `(ctx: PgCtx) => Partial<DatabaseAdapter>` that returns its methods, so the big adapter
 * can be built up one domain at a time and stays parallelizable. Keeping this type in its own file
 * avoids an import cycle between db-postgres.ts and the domain modules.
 */

/** The minimal Postgres surface a domain store needs. `pg.Pool`/`pg.Client` satisfy the query shape. */
export interface PgCtx {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  /**
   * SQL expression for the current UTC time as `YYYY-MM-DD HH:MM:SS` text — the exact shape SQLite's
   * `datetime('now')` produces. Splice it into DDL/UPDATE defaults so timestamps read back identically.
   */
  readonly now: string;
}

/** UTC `YYYY-MM-DD HH:MM:SS`, matching SQLite `datetime('now')`. */
export const NOW_SQL = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * Read `expires_at`-style BIGINT columns (pg returns bigint as string) as a JS number, or null.
 * Small shared helper many domain stores need.
 */
export function pgBigintToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
