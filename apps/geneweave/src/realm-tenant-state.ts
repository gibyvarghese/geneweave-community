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
  type SqlClient, type SqlDialect, type RealmStateRecord, type RealmStateOverlay, type ResolvedState, type RealmContext,
} from '@weaveintel/realm';

const STATE_TABLE = 'realm_tenant_state';
const rootCtx = (tenantId: string): RealmContext => ({ tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] });
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
  const own = await store(client, dialect).listForTenant(family, tenantId);
  const byKey = new Map(own.map((r) => [r.logicalKey, r]));
  const ctx = rootCtx(tenantId);
  for (const k of logicalKeys) {
    const overlays = new Map<string, RealmStateOverlay>();
    const o = byKey.get(k);
    if (o) overlays.set(tenantId, o);
    out.set(k, resolveState(ctx, overlays));
  }
  return out;
}
