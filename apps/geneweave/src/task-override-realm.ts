/**
 * Tenancy Realm (Section C9) — resolve per-tenant task-type routing overrides down the tenant lineage.
 *
 * `task_type_tenant_overrides` predates the realm: it stored a flat per-tenant row (weights / preferred
 * model / cost ceiling for a routing task_key) and the routing simulator read only the tenant's OWN row
 * — a child tenant saw nothing a parent org had configured. This consolidates that onto the shared realm
 * resolver (`resolveEffective` / nearest-owner-wins), so a parent org can set a task override once and
 * every child tenant inherits it unless the child sets its own. No schema change — `tenant_id` is the
 * owner (the table has no global rows), `task_key` is the logical key; rows are shared down the subtree.
 */
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import type { TaskTypeTenantOverrideRow } from './db-types/routing.js';

type Wrapped = { _row: TaskTypeTenantOverrideRow };

/** Map an override row into a realm record. Every row is tenant-owned (no global defaults exist). */
function toRealmRecord(r: TaskTypeTenantOverrideRow): RealmRecord<Wrapped> {
  return {
    id: r.id,
    realm: 'tenant',
    ownerTenantId: r.tenant_id,
    logicalKey: r.task_key,
    originId: null,
    originHash: null,
    // The override content that matters for drift/dedup — a stable projection of the tuned fields.
    contentHash: JSON.stringify([
      r.weights, r.preferred_model_id, r.preferred_provider, r.preferred_boost_pct,
      r.cost_ceiling_per_call, r.optimisation_strategy, r.enabled,
    ]),
    trackMode: 'pin',
    // Shared down the subtree so a parent org's override inherits to child tenants; a child's own
    // row for the same task_key still wins (nearest-owner-wins).
    shareMode: 'subtree',
    _row: r,
  };
}

/**
 * The effective task-type overrides for a tenant, resolved nearest-owner-wins down the lineage: the
 * tenant's own row per task_key → the nearest ancestor org's row → nothing. `allRows` is every override
 * row across all owners. With no tenant, returns [] (the table has no global defaults). Optionally
 * narrow to a single `taskKey`.
 */
export function resolveTenantEffectiveTaskTypeOverrides(
  allRows: readonly TaskTypeTenantOverrideRow[],
  tenantId: string | null | undefined,
  ctx?: RealmContext,
  taskKey?: string,
): TaskTypeTenantOverrideRow[] {
  if (!tenantId) return [];
  const rows = taskKey ? allRows.filter((r) => r.task_key === taskKey) : allRows;
  if (rows.length === 0) return [];
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  return resolveEffective(rows.map(toRealmRecord), context).map((e) => (e as unknown as Wrapped)._row);
}
