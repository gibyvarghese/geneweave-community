/**
 * Tenancy Realm (Section C11) — resolve model capability scores down the tenant lineage.
 *
 * `model_capability_scores` predates the realm: a row is either a GLOBAL default (`tenant_id IS NULL`)
 * or specific to one tenant, and `listCapabilityScores({tenantId})` did a flat two-level merge — the
 * tenant's own rows plus the globals. A child tenant inherited only the globals, never a parent org's
 * tuned scores. This consolidates that onto the shared realm resolver (`resolveEffective` /
 * nearest-owner-wins), keyed per (provider, model, task) CELL, so each cell resolves to the tenant's own
 * row → the nearest ancestor org's row → the global default. No schema change — `tenant_id` is the owner
 * (NULL = global), and the (provider, model, task) tuple is the logical key; tenant rows are shared down
 * the subtree so a parent org's scores inherit to child tenants.
 */
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import type { ModelCapabilityScoreRow } from './db-types/routing.js';

type Wrapped = { _row: ModelCapabilityScoreRow };

/** The per-cell logical key: one capability score per (provider, model, task). */
const cellKey = (r: ModelCapabilityScoreRow): string => `${r.provider}::${r.model_id}::${r.task_key}`;

/** Map a capability-score row into a realm record. NULL owner → the global default. Since m168, the
 *  canonical owner is `owner_tenant_id` (kept in lockstep with the legacy `tenant_id`); fall back to
 *  `tenant_id` for any row written before the converge migration ran. */
function toRealmRecord(r: ModelCapabilityScoreRow): RealmRecord<Wrapped> {
  const ownerRaw = r.owner_tenant_id ?? r.tenant_id;
  const owner = ownerRaw && ownerRaw !== '' ? ownerRaw : null;
  return {
    id: r.id,
    realm: owner ? 'tenant' : 'global',
    ownerTenantId: owner,
    logicalKey: cellKey(r),
    originId: null,
    originHash: null,
    // A stable projection of the scored fields for drift/dedup.
    contentHash: JSON.stringify([
      r.quality_score, r.supports_tools, r.supports_streaming, r.supports_thinking,
      r.supports_json_mode, r.supports_vision, r.max_output_tokens, r.is_active,
      r.production_signal_score, r.signal_sample_count,
    ]),
    trackMode: 'pin',
    // Shared down the subtree so a parent org's tuned score inherits to child tenants; a child's own
    // row for the same cell still wins (nearest-owner-wins).
    shareMode: owner ? 'subtree' : 'private',
    _row: r,
  };
}

/**
 * The effective capability scores for a tenant, resolved per (provider, model, task) cell nearest-owner-
 * wins down the lineage: the tenant's own row → the nearest ancestor org's row → the global default.
 * `allRows` can be the whole table — `resolveEffective` filters to what the tenant may see (globals +
 * its own + ancestor rows shared down the subtree) and drops unrelated tenants' rows. With no tenant,
 * only the globals are returned (unchanged pre-realm behaviour).
 */
export function resolveTenantEffectiveCapabilityScores(
  allRows: readonly ModelCapabilityScoreRow[],
  tenantId: string | null | undefined,
  ctx?: RealmContext,
): ModelCapabilityScoreRow[] {
  if (!tenantId) return allRows.filter((r) => { const o = r.owner_tenant_id ?? r.tenant_id; return o === null || o === ''; });
  if (allRows.length === 0) return [];
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  return resolveEffective(allRows.map(toRealmRecord), context).map((e) => (e as unknown as Wrapped)._row);
}
