/**
 * Tenancy Realm — resolve the tenant-effective TOOL POLICY (content forking for tool gates).
 *
 * A built-in tool policy is a *global original* until a tenant forks its own copy (customizes a policy's
 * approval gate / rate limits / allowed risk levels / dry-run / time window). tool_policies keeps its
 * inline UNIQUE(key), so a fork can't reuse the key: `logical_key = key` is the shared identity, and a
 * fork takes a tenant-scoped `key#tenant`. Resolution keys on logical_key and RESTORES the canonical key
 * on the effective row, so the DbToolPolicyResolver looks the policy up under its normal key but gets the
 * tenant's forked gates. Mirrors the prompt/worker/guardrail bridges over @weaveintel/realm's
 * table-agnostic resolver — no resolution logic is duplicated.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { TOOLPOLICY_SEMANTIC_COLS } from './migrations/m157-realm-columns-tool-policies.js';
import type { ToolPolicyRow } from './db-types/tools.js';

/** Recompute a tool policy's content_hash over its gate fields (matches m157; excludes key/name/enabled). */
export function toolPolicyContentHash(row: Partial<ToolPolicyRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of TOOLPOLICY_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a tool policy (copy-on-write). */
export type ToolPolicyOverrides = Partial<Pick<ToolPolicyRow, (typeof TOOLPOLICY_SEMANTIC_COLS)[number] | 'share_mode'>>;

const logicalKeyOf = (r: { logical_key?: string | null; key?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.key ?? undefined) || String(r.id ?? '');

function toToolPolicyRealmRecord(row: ToolPolicyRow): RealmRecord<Record<string, unknown>> {
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
 * The ONE effective tool policy per logical key for a tenant — its own fork if present, else a shared
 * ancestor's, else the global — with the canonical `key` restored (a fork's tenant-scoped `key#tenant`
 * is replaced by its logical key so the resolver addresses the policy under its normal key). With no
 * tenant, returns the global policies unchanged.
 */
export function resolveTenantEffectiveToolPolicies(allPolicies: readonly ToolPolicyRow[], tenantId: string | null | undefined, ctx?: RealmContext): ToolPolicyRow[] {
  if (!tenantId) return allPolicies.filter((p) => (p.realm ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const effective = resolveEffective(allPolicies.map(toToolPolicyRealmRecord), context);
  return effective.map((e) => {
    const { realmProvenance, ...row } = e;
    const p = row as unknown as ToolPolicyRow;
    // Present the fork under the canonical policy key (its logical key), not the tenant-scoped alias.
    return { ...p, key: p.logical_key ?? p.key };
  });
}

/**
 * Build a tenant's copy-on-write fork of a GLOBAL tool policy: a new row with a tenant-scoped key (so the
 * inline UNIQUE(key) is satisfied), logical_key = the global's key, provenance columns for drift, the
 * tenant's overrides, and a fresh content_hash. Does not touch the DB — persist via insertRealmToolPolicyRow.
 */
export function buildTenantToolPolicyFork(global: ToolPolicyRow, tenantId: string, overrides: ToolPolicyOverrides = {}): Omit<ToolPolicyRow, 'created_at' | 'updated_at'> {
  const logicalKey = logicalKeyOf(global);
  const forked = { ...global, id: newUUIDv7() } as Record<string, unknown>;
  for (const c of TOOLPOLICY_SEMANTIC_COLS) if (overrides[c] !== undefined) forked[c] = overrides[c];
  forked['key'] = `${logicalKey}#${tenantId}`; // tenant-scoped, satisfies UNIQUE(key)
  forked['enabled'] = global.enabled ?? 1;
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKey;
  forked['origin_id'] = global.id;
  forked['origin_hash'] = global.content_hash ?? '';
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  forked['content_hash'] = toolPolicyContentHash(forked as Partial<ToolPolicyRow>);
  return forked as unknown as Omit<ToolPolicyRow, 'created_at' | 'updated_at'>;
}
