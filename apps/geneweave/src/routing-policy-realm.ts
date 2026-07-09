/**
 * Tenancy Realm — resolve the tenant-effective ROUTING POLICY (content forking for model routing).
 *
 * A built-in routing policy is a *global original* until a tenant forks its own copy (customizes the
 * routing strategy / weights / fallbacks). routing_policies keys on `name` with NO UNIQUE constraint
 * (the guardrails case), so a fork KEEPS the same name: `logical_key = name` is the shared identity and
 * resolution is plain nearest-owner-wins. Mirrors the prompt/guardrail bridges over @weaveintel/realm's
 * table-agnostic resolver — no resolution logic is duplicated.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { ROUTING_SEMANTIC_COLS } from './migrations/m158-realm-columns-routing-cost.js';
import type { RoutingPolicyRow } from './db-types/routing.js';

/** Recompute a routing policy's content_hash over its rule fields (matches m158; excludes name/enabled). */
export function routingContentHash(row: Partial<RoutingPolicyRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of ROUTING_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a routing policy (copy-on-write). */
export type RoutingOverrides = Partial<Pick<RoutingPolicyRow, (typeof ROUTING_SEMANTIC_COLS)[number] | 'share_mode'>>;

const logicalKeyOf = (r: { logical_key?: string | null; name?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.name ?? undefined) || String(r.id ?? '');

function toRoutingRealmRecord(row: RoutingPolicyRow): RealmRecord<Record<string, unknown>> {
  return {
    ...(row as unknown as Record<string, unknown>),
    id: row.id,
    realm: row.realm === 'tenant' ? 'tenant' : 'global',
    ownerTenantId: row.owner_tenant_id ?? null,
    logicalKey: logicalKeyOf(row),
    originId: row.origin_id ?? null,
    originHash: row.origin_hash ?? null,
    contentHash: row.content_hash ?? '',
    trackMode: row.track_mode === 'track_latest' ? 'track_latest' : 'pin',
    shareMode: row.share_mode === 'children' ? 'children' : row.share_mode === 'subtree' ? 'subtree' : 'private',
  };
}

/**
 * The ONE effective routing policy per logical key for a tenant — its own fork if present, else a shared
 * ancestor's, else the global. With no tenant, returns the global policies unchanged. A fork keeps its
 * own name (routing_policies has no UNIQUE(name)), so no name aliasing is needed.
 */
export function resolveTenantEffectiveRoutingPolicies(allPolicies: readonly RoutingPolicyRow[], tenantId: string | null | undefined, ctx?: RealmContext): RoutingPolicyRow[] {
  if (!tenantId) return allPolicies.filter((p) => (p.realm ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const effective = resolveEffective(allPolicies.map(toRoutingRealmRecord), context);
  return effective.map((e) => {
    const { realmProvenance, ...row } = e;
    return row as unknown as RoutingPolicyRow;
  });
}

/**
 * Build a tenant's copy-on-write fork of a GLOBAL routing policy: a new row with logical_key = the
 * global's name (shared identity), provenance columns for drift, the tenant's overrides, and a fresh
 * content_hash. Does not touch the DB — persist via insertRealmRoutingPolicyRow.
 */
export function buildTenantRoutingPolicyFork(global: RoutingPolicyRow, tenantId: string, overrides: RoutingOverrides = {}): Omit<RoutingPolicyRow, 'created_at' | 'updated_at'> {
  const logicalKey = logicalKeyOf(global);
  const forked = { ...global, id: newUUIDv7() } as Record<string, unknown>;
  for (const c of ROUTING_SEMANTIC_COLS) if (overrides[c] !== undefined) forked[c] = overrides[c];
  forked['enabled'] = global.enabled ?? 1;
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKey;
  forked['origin_id'] = global.id;
  forked['origin_hash'] = global.content_hash ?? '';
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  forked['content_hash'] = routingContentHash(forked as Partial<RoutingPolicyRow>);
  return forked as unknown as Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>;
}
