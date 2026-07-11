// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Postgres Row-Level Security (Section H), a DEFENSE-IN-DEPTH backstop.
 *
 * Tenant isolation is enforced by the application: every query the adapter builds carries the tenant
 * predicate, and that is the CORRECTNESS mechanism. This adds a second, independent line of defence at
 * the database itself — so that even if an app-layer query ever forgot its tenant scope, Postgres would
 * still refuse to return another tenant's rows. It is Postgres-only (SQLite has no RLS) and OFF by
 * default; a deployment opts in with `GENEWEAVE_PG_RLS=1`.
 *
 * How it works. Every tenant-scoped table gets a policy keyed on a per-transaction GUC,
 * `app.current_tenant`:
 *   • When the GUC is UNSET (the normal case — migrations, seeding, admin/cross-tenant reads, and every
 *     query the app runs today), the policy passes everything. Enabling RLS therefore changes nothing
 *     about existing behaviour.
 *   • When a caller enters a tenant scope via `withTenantContext(pool, 'acme', …)`, the GUC is set for
 *     that transaction and the policy restricts every table to that tenant's rows (global rows —
 *     `tenant_id` NULL or '' — stay visible, since those are shared, but another tenant's rows become
 *     invisible and un-writable). That is the backstop: a cross-tenant read inside the scope returns
 *     zero rows even if the SQL explicitly asked for the other tenant.
 *
 * Two things make the backstop actually bite. `FORCE ROW LEVEL SECURITY` makes the policy apply to the
 * table OWNER (ordinary RLS skips the owner). And — the subtle one — a Postgres SUPERUSER always bypasses
 * RLS entirely, even with FORCE; the app (and Testcontainers) connect as a superuser/owner. So a scoped
 * transaction `SET LOCAL ROLE`s to a dedicated non-superuser, `NOBYPASSRLS` role (`realm_tenant_member`)
 * for the duration of the scope — that role IS subject to the policy. The switch is transaction-local, so
 * the connection returns to the pool as its normal self. Idempotent throughout.
 */
import { NOW_SQL } from '../db-postgres-ctx.js';

/** A query-capable pg surface (a `pg.Pool` or `pg.Client`) — enough for the RLS DDL + catalog reads. */
export interface RlsQueryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
/** A pool that can also hand out a dedicated connection — required for `withTenantContext`. */
export interface RlsPool extends RlsQueryable {
  connect(): Promise<RlsClient>;
}
export interface RlsClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

/** The GUC that carries the active tenant for a scoped transaction. */
export const TENANT_GUC = 'app.current_tenant';
const POLICY = 'realm_tenant_isolation';
/** The non-superuser role a scoped transaction assumes so RLS actually applies (superusers bypass it). */
export const TENANT_ROLE = 'realm_tenant_member';

/**
 * Every table that carries a `tenant_id` column — discovered from the live catalog so the set stays in
 * sync with the schema (and any future table) rather than a hand-maintained list. The `tenants` registry
 * itself has no `tenant_id`, so it is naturally excluded — lineage resolution needs to see the whole tree.
 */
export async function tenantScopedTables(pool: RlsQueryable): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `);
  return rows.map((r) => String(r['table_name']));
}

/**
 * Enable RLS + the tenant-isolation policy on every tenant-scoped table. Idempotent: re-running is a
 * no-op (ENABLE/FORCE are already-on, the policy is dropped-then-recreated so its definition can evolve).
 */
export async function enableRealmRls(pool: RlsQueryable): Promise<{ tables: string[] }> {
  // The scoped role that RLS applies to. NOLOGIN (assumed only via SET ROLE), NOBYPASSRLS (never skips
  // policies). Granted to the connecting role so a scoped transaction can SET ROLE to it, and given DML
  // on every table so a scoped callback can also touch non-tenant tables without a permission error.
  await pool.query(`DO $rls$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_ROLE}') THEN
      CREATE ROLE ${TENANT_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $rls$;`);
  await pool.query(`GRANT ${TENANT_ROLE} TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${TENANT_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TENANT_ROLE}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TENANT_ROLE}`);

  const tables = await tenantScopedTables(pool);
  for (const table of tables) {
    const t = `"${table}"`;
    await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS ${POLICY} ON ${t}`);
    // Unset GUC → see/write all (unchanged behaviour). Set GUC → only this tenant's rows + global rows.
    await pool.query(`
      CREATE POLICY ${POLICY} ON ${t}
        USING (
          current_setting('${TENANT_GUC}', true) IS NULL
          OR current_setting('${TENANT_GUC}', true) = ''
          OR tenant_id IS NOT DISTINCT FROM current_setting('${TENANT_GUC}', true)
          OR tenant_id IS NULL
          OR tenant_id = ''
        )
        WITH CHECK (
          current_setting('${TENANT_GUC}', true) IS NULL
          OR current_setting('${TENANT_GUC}', true) = ''
          OR tenant_id IS NOT DISTINCT FROM current_setting('${TENANT_GUC}', true)
          OR tenant_id IS NULL
          OR tenant_id = ''
        )
    `);
  }
  return { tables };
}

/** Remove the policy + disable RLS on every tenant-scoped table (opt-out / teardown). Idempotent. */
export async function disableRealmRls(pool: RlsQueryable): Promise<{ tables: string[] }> {
  const tables = await tenantScopedTables(pool);
  for (const table of tables) {
    const t = `"${table}"`;
    await pool.query(`DROP POLICY IF EXISTS ${POLICY} ON ${t}`);
    await pool.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
  }
  return { tables };
}

/** Is RLS installed on a given table? (For assertions / status.) */
export async function isRealmRlsEnabled(pool: RlsQueryable, table = 'notes'): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
    [table],
  );
  const r = rows[0] as { relrowsecurity?: boolean; relforcerowsecurity?: boolean } | undefined;
  return !!r?.relrowsecurity && !!r?.relforcerowsecurity;
}

/** The scoped query surface handed to a `withTenantContext` callback — the same shape as `PgCtx`. */
export interface ScopedCtx {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  readonly now: string;
}

/**
 * Run `fn` inside a transaction bound to `tenantId`: a dedicated pooled connection with the
 * `app.current_tenant` GUC set for the transaction, so RLS scopes every statement `fn` runs to that
 * tenant. The GUC is set with `set_config(…, true)` (transaction-local) via a bound parameter, so a
 * hostile tenant id cannot escape the value — it can never be SQL. Commits on success, rolls back on
 * throw, and always returns the connection to the pool.
 *
 * A null/empty `tenantId` runs with NO tenant scope (the admin/global context) — RLS passes everything,
 * which is the same as running outside a scope. This is deliberate: it mirrors the app's "null = global".
 */
export async function withTenantContext<T>(
  pool: RlsPool,
  tenantId: string | null,
  fn: (ctx: ScopedCtx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `set_config(name, value, is_local=true)` — transaction-scoped, parameter-bound (injection-safe).
    await client.query(`SELECT set_config('${TENANT_GUC}', $1, true)`, [tenantId ?? '']);
    // Drop to the non-superuser role for the scope, so FORCE RLS actually applies (a superuser bypasses
    // it). Transaction-local — the connection reverts to its normal role on COMMIT/ROLLBACK.
    await client.query(`SET LOCAL ROLE ${TENANT_ROLE}`);
    const ctx: ScopedCtx = { query: (text, params) => client.query(text, params), now: NOW_SQL };
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be broken; release below */ }
    throw err;
  } finally {
    client.release();
  }
}
