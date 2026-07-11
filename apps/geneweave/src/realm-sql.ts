// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm / Upgrade Engine — the one-line dialect helpers shared by every realm + upgrade module.
 *
 * The realm and upgrade code is written once against the framework's `SqlClient` seam and runs on both
 * SQLite and Postgres. Two things differ between the dialects at the SQL-string level: the bound-parameter
 * placeholder (`?` vs `$1`) and the "now" expression. These were historically re-declared as a private
 * `ph`/`nowExpr` in each realm module; this module states them once so new code composes instead of
 * copying. (The pre-existing private copies in realm-diff/governance/hierarchy still work and are left in
 * place to avoid churning stable modules; new modules import from here.)
 */
import type { SqlDialect } from '@weaveintel/realm';

/**
 * The bound-parameter placeholder for the i-th parameter in `dialect`.
 * @param dialect 'sqlite' | 'postgres'.
 * @param i 1-based parameter index (Postgres is `$1`, `$2`, …; SQLite is always `?`).
 * @returns the placeholder string to splice into the SQL.
 */
export const ph = (dialect: SqlDialect, i: number): string => (dialect === 'postgres' ? `$${i}` : '?');

/**
 * The SQL expression yielding the current UTC timestamp in the app's canonical `YYYY-MM-DD HH24:MI:SS`
 * text form (both engines store timestamps as text in this shape).
 * @param dialect 'sqlite' | 'postgres'.
 * @returns a SQL fragment usable in an INSERT/UPDATE value position.
 */
export const nowExpr = (dialect: SqlDialect): string =>
  dialect === 'postgres' ? `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')` : `datetime('now')`;
