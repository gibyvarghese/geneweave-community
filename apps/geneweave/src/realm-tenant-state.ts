/**
 * Tenancy Realm Phase 3 (app) — per-tenant state overlay wiring.
 *
 * A tenant can turn a built-in skill/prompt OFF for itself, bump its priority, or pin a version —
 * WITHOUT forking it. This is a thin bridge from the app's `realm_tenant_state` table to
 * @weaveintel/realm's state store + resolver. ONE implementation over the framework `SqlClient` seam
 * serves both SQLite (this.d) and Postgres (ctx). Tenants are flat roots today (m150), so we resolve
 * against a depth-0 context; when the tenant tree gains depth, pass the real lineage and parent-org
 * policy inherits down for free.
 */
import {
  createSqlStateStore, resolveState,
  type SqlClient, type SqlDialect, type RealmStateRecord, type RealmStateOverlay, type ResolvedState,
} from '@weaveintel/realm';
import { buildTenantContext } from './realm-hierarchy.js';

const STATE_TABLE = 'realm_tenant_state';
const store = (client: SqlClient, dialect: SqlDialect) => createSqlStateStore({ client, dialect, table: STATE_TABLE });

export async function setRealmState(client: SqlClient, dialect: SqlDialect, family: string, logicalKey: string, tenantId: string, patch: Partial<RealmStateOverlay>): Promise<RealmStateRecord> {
  return store(client, dialect).setState(family, logicalKey, tenantId, patch);
}
export async function clearRealmState(client: SqlClient, dialect: SqlDialect, family: string, logicalKey: string, tenantId: string): Promise<void> {
  return store(client, dialect).clearState(family, logicalKey, tenantId);
}
export async function listRealmStates(client: SqlClient, dialect: SqlDialect, family: string, tenantId: string): Promise<RealmStateRecord[]> {
  return store(client, dialect).listForTenant(family, tenantId);
}

/**
 * Resolve the effective disposition for many logical keys at once (one query for the tenant's overlays,
 * then merge in memory). Returns a map key → ResolvedState. `active` is false only on an explicit
 * disable, so callers filter with `state.active === false`.
 */
export async function resolveRealmStates(client: SqlClient, dialect: SqlDialect, family: string, tenantId: string | null, logicalKeys: readonly string[]): Promise<Map<string, ResolvedState>> {
  const out = new Map<string, ResolvedState>();
  if (!tenantId || logicalKeys.length === 0) return out; // no tenant → everything inherits the shared default
  // Phase 4: resolve against the REAL lineage so a parent org's overlay inherits down to this tenant.
  const ctx = await buildTenantContext(client, dialect, tenantId);
  const st = store(client, dialect);
  // One pass per lineage tenant (depth is small) → overlays keyed by tenant, then per-field nearest-wins.
  const byTenant = new Map<string, Map<string, RealmStateRecord>>();
  for (const node of ctx.lineage) {
    byTenant.set(node.tenantId, new Map((await st.listForTenant(family, node.tenantId)).map((r) => [r.logicalKey, r])));
  }
  for (const k of logicalKeys) {
    const overlays = new Map<string, RealmStateOverlay>();
    for (const node of ctx.lineage) { const o = byTenant.get(node.tenantId)?.get(k); if (o) overlays.set(node.tenantId, o); }
    out.set(k, resolveState(ctx, overlays));
  }
  return out;
}
