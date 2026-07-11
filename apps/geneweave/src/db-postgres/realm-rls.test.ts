// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Section H: Postgres Row-Level Security defense-in-depth, on a REAL Postgres (throwaway
 * Docker container). Proves the backstop actually isolates tenants at the database, independently of the
 * app's query predicate:
 *   • with RLS enabled and a tenant scope set, a query can see only that tenant's rows (+ global rows) —
 *     even a query that EXPLICITLY selects another tenant's rows returns nothing (the money test);
 *   • writes are constrained the same way (WITH CHECK): a scope can't insert another tenant's row;
 *   • the unscoped/admin path (no context) still sees everything, so nothing existing breaks;
 *   • it holds under the superuser the app connects as (FORCE ROW LEVEL SECURITY);
 *   • it is opt-in and reversible, and isolates cleanly across many tenants under load.
 *
 * Auto-skips without Docker so `npm test` stays green anywhere.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '../db.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import { enableRealmRls, disableRealmRls, isRealmRlsEnabled, withTenantContext, tenantScopedTables } from './realm-rls.js';

const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const A = 'rls-acme';
const B = 'rls-globex';

describe.skipIf(!HAS_DOCKER)('Tenancy Realm Section H — Postgres RLS defense-in-depth (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: DatabaseAdapter;

  /** Insert a note row directly (bypassing the app predicate) so RLS is the only thing scoping reads. */
  async function seedNote(tenantId: string | null, title: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO notes (id, owner_user_id, tenant_id, title) VALUES ($1, $2, $3, $4)`,
      [id, `owner-${id}`, tenantId, title],
    );
    return id;
  }

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects at teardown
    pg = createPostgresAdapter({ client: pool });
    await pg.initialize();
    // Tenants must exist (users.tenant_id FK from m162 — not needed for notes, but keeps the tree real).
    for (const t of [A, B]) {
      await pool.query(`INSERT INTO tenants (id,name,parent_tenant_id,path,depth,status) VALUES ($1,$1,NULL,'/'||$1||'/',0,'active') ON CONFLICT (id) DO NOTHING`, [t]);
    }
  }, 240_000);

  afterAll(async () => { await pool?.end(); await container?.stop(); });

  it('SETUP: RLS is off by default; enabling it turns on FORCE row security on tenant-scoped tables', async () => {
    expect(await isRealmRlsEnabled(pool, 'notes')).toBe(false); // initialize() ran WITHOUT GENEWEAVE_PG_RLS
    const { tables } = await enableRealmRls(pool);
    expect(tables).toContain('notes');
    expect(tables).toContain('users');
    expect(tables).not.toContain('tenants'); // the registry has no tenant_id → not scoped
    expect(await isRealmRlsEnabled(pool, 'notes')).toBe(true);
  });

  it('POSITIVE: a tenant scope sees its own rows and the global (null-tenant) rows', async () => {
    await seedNote(A, 'acme note');
    await seedNote(B, 'globex note');
    const gid = await seedNote(null, 'global note');

    const seen = await withTenantContext(pool, A, async (ctx) =>
      (await ctx.query(`SELECT title FROM notes WHERE title IN ('acme note','globex note','global note')`)).rows.map((r) => r['title']));
    expect(seen).toContain('acme note');
    expect(seen).toContain('global note'); // global rows stay visible
    expect(seen).not.toContain('globex note'); // another tenant's row is filtered out
    void gid;
  });

  it('SECURITY (the backstop): a query EXPLICITLY selecting another tenant returns zero rows under a scope', async () => {
    // This is the whole point: even if an app query forgot its scope and asked for tenant B directly,
    // RLS makes B invisible while we are in tenant A's context.
    const rows = await withTenantContext(pool, A, async (ctx) =>
      (await ctx.query(`SELECT id FROM notes WHERE tenant_id = $1`, [B])).rows);
    expect(rows.length).toBe(0);

    // …and the count of ALL notes visible in A's scope excludes B's rows entirely.
    const inA = await withTenantContext(pool, A, async (ctx) =>
      Number((await ctx.query(`SELECT count(*)::int AS c FROM notes WHERE tenant_id = $1`, [A])).rows[0]!['c']));
    const bVisibleInA = await withTenantContext(pool, A, async (ctx) =>
      Number((await ctx.query(`SELECT count(*)::int AS c FROM notes WHERE tenant_id = $1`, [B])).rows[0]!['c']));
    expect(inA).toBeGreaterThan(0);
    expect(bVisibleInA).toBe(0);
  });

  it('WITH CHECK: a scope cannot INSERT a row belonging to another tenant', async () => {
    await expect(withTenantContext(pool, A, async (ctx) => {
      await ctx.query(`INSERT INTO notes (id, owner_user_id, tenant_id, title) VALUES ($1,$2,$3,$4)`,
        [randomUUID(), 'x', B, 'smuggled into B']);
    })).rejects.toThrow(/row-level security|policy/i);
    // The smuggled row never landed (visible from the unscoped/admin view).
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM notes WHERE title = 'smuggled into B'`);
    expect(Number(rows[0]!.c)).toBe(0);
  });

  it('WITH CHECK: a scope CAN insert its own tenant’s row, and reads it back within the scope', async () => {
    const title = `owned-by-A-${randomUUID().slice(0, 8)}`;
    const readBack = await withTenantContext(pool, A, async (ctx) => {
      await ctx.query(`INSERT INTO notes (id, owner_user_id, tenant_id, title) VALUES ($1,$2,$3,$4)`, [randomUUID(), 'x', A, title]);
      return (await ctx.query(`SELECT title FROM notes WHERE title = $1`, [title])).rows.map((r) => r['title']);
    });
    expect(readBack).toEqual([title]);
  });

  it('NEGATIVE: the UNSCOPED (admin) path still sees every tenant — enabling RLS breaks nothing existing', async () => {
    // A plain pool.query with no tenant context is the admin/cross-tenant path the app uses today.
    const { rows } = await pool.query(`SELECT DISTINCT tenant_id FROM notes WHERE tenant_id IN ($1,$2)`, [A, B]);
    const tenants = rows.map((r: Record<string, unknown>) => r['tenant_id']);
    expect(tenants).toContain(A);
    expect(tenants).toContain(B); // both visible → admin path unbroken
  });

  it('NEGATIVE: a rolled-back scope leaves no data and does not leak the GUC to the next pool user', async () => {
    const title = `rollback-${randomUUID().slice(0, 8)}`;
    await expect(withTenantContext(pool, A, async (ctx) => {
      await ctx.query(`INSERT INTO notes (id, owner_user_id, tenant_id, title) VALUES ($1,$2,$3,$4)`, [randomUUID(), 'x', A, title]);
      throw new Error('boom'); // force ROLLBACK
    })).rejects.toThrow('boom');
    // insert rolled back
    expect(Number((await pool.query(`SELECT count(*)::int AS c FROM notes WHERE title = $1`, [title])).rows[0]!.c)).toBe(0);
    // GUC was transaction-local (set_config …, true) — a fresh pool query has no lingering scope.
    const guc = (await pool.query(`SELECT current_setting('app.current_tenant', true) AS g`)).rows[0]!.g;
    expect(guc === null || guc === '').toBe(true);
  });

  it('SECURITY: a hostile tenant id is a bound value, never SQL — it matches no tenant, leaks nothing', async () => {
    const HOSTILE = "acme'; DROP TABLE notes; --";
    // Under a scope that matches no real tenant, NO tenant-specific row is visible (globals may be).
    const tenantRowsVisible = await withTenantContext(pool, HOSTILE, async (ctx) =>
      Number((await ctx.query(`SELECT count(*)::int AS c FROM notes WHERE tenant_id IS NOT NULL AND tenant_id <> ''`)).rows[0]!['c']));
    expect(tenantRowsVisible).toBe(0); // no acme/globex/etc rows leak to a bogus tenant
    // The injection did not execute — notes still exists with its rows intact.
    expect(Number((await pool.query(`SELECT count(*)::int AS c FROM notes`)).rows[0]!.c)).toBeGreaterThan(0);
  });

  it('STRESS: 40 tenants each see exactly their own row and never any sibling’s', async () => {
    const tenants = Array.from({ length: 40 }, (_, i) => `rls-t${i}`);
    for (const t of tenants) {
      await pool.query(`INSERT INTO tenants (id,name,parent_tenant_id,path,depth,status) VALUES ($1,$1,NULL,'/'||$1||'/',0,'active') ON CONFLICT (id) DO NOTHING`, [t]);
      await seedNote(t, `note-for-${t}`);
    }
    for (const t of tenants) {
      const visible = await withTenantContext(pool, t, async (ctx) =>
        (await ctx.query(`SELECT title FROM notes WHERE title LIKE 'note-for-rls-t%'`)).rows.map((r) => r['title']));
      // Exactly this tenant's note is visible among the 40 (globals don't match the LIKE).
      expect(visible).toEqual([`note-for-${t}`]);
    }
  }, 120_000);

  it('OPT-OUT: disableRealmRls removes the policies and RLS turns off', async () => {
    const { tables } = await disableRealmRls(pool);
    expect(tables).toContain('notes');
    expect(await isRealmRlsEnabled(pool, 'notes')).toBe(false);
    // With RLS off, a "scope" no longer filters (the backstop is gone) — proving it was RLS doing the work.
    await seedNote(B, 'post-disable B note');
    const seen = await withTenantContext(pool, A, async (ctx) =>
      (await ctx.query(`SELECT count(*)::int AS c FROM notes WHERE tenant_id = $1`, [B])).rows);
    expect(Number(seen[0]!['c'])).toBeGreaterThan(0); // B now visible from A's "scope" — RLS was the enforcer
  });

  it('COVERAGE: RLS is applied to the full tenant-scoped table set (100+ tables), not a hand-picked few', async () => {
    await enableRealmRls(pool); // re-enable after the opt-out test
    const tables = await tenantScopedTables(pool);
    expect(tables.length).toBeGreaterThan(100);
    for (const core of ['notes', 'users', 'artifacts', 'workflow_runs', 'realm_proposals', 'realm_tenant_state']) {
      expect(tables).toContain(core);
    }
  });
});
