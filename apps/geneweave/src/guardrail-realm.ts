/**
 * Tenancy Realm — resolve the tenant-effective GUARDRAIL (content forking for guardrail policies).
 *
 * A built-in guardrail is a *global original* until a tenant forks its own copy (customizes the
 * guardrail's config — thresholds, patterns, judge model, compliance framework). Unlike worker_agents,
 * `guardrails.name` has NO UNIQUE constraint, so a fork keeps the SAME name: `logical_key = name` is the
 * shared identity, and resolution is plain nearest-owner-wins with NO name aliasing/restoration. Mirrors
 * the prompt/worker bridges over @weaveintel/realm's table-agnostic resolver — no resolution logic is
 * duplicated.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { GUARDRAIL_SEMANTIC_COLS } from './migrations/m156-realm-columns-guardrails.js';
import type { GuardrailRow } from './db-types/routing.js';

/** Recompute a guardrail's content_hash over its policy fields (matches m156; excludes name/priority/enabled). */
export function guardrailContentHash(row: Partial<GuardrailRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of GUARDRAIL_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a guardrail (copy-on-write). */
export type GuardrailOverrides = Partial<Pick<GuardrailRow, (typeof GUARDRAIL_SEMANTIC_COLS)[number] | 'share_mode'>>;

/** A guardrail's shared identity: the stored logical_key, else its name (guardrails have no UNIQUE(name)). */
export const guardrailLogicalKey = (r: { logical_key?: string | null; name?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.name ?? undefined) || String(r.id ?? '');
const logicalKeyOf = guardrailLogicalKey;

function toGuardrailRealmRecord(row: GuardrailRow): RealmRecord<Record<string, unknown>> {
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
 * The ONE effective guardrail per logical key for a tenant — its own fork if present, else a shared
 * ancestor's, else the global. With no tenant, returns the global guardrails unchanged. A fork keeps
 * its own name (guardrails has no UNIQUE(name)), so no name aliasing is needed.
 */
export function resolveTenantEffectiveGuardrails(allGuardrails: readonly GuardrailRow[], tenantId: string | null | undefined, ctx?: RealmContext): GuardrailRow[] {
  if (!tenantId) return allGuardrails.filter((g) => (g.realm ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const effective = resolveEffective(allGuardrails.map(toGuardrailRealmRecord), context);
  return effective.map((e) => {
    const { realmProvenance, ...row } = e;
    return row as unknown as GuardrailRow;
  });
}

/**
 * Build a tenant's copy-on-write fork of a GLOBAL guardrail: a new row with logical_key = the global's
 * name (shared identity), provenance columns for drift, the tenant's overrides, and a fresh content_hash.
 * Does not touch the DB — persist via insertRealmGuardrailRow.
 */
export function buildTenantGuardrailFork(global: GuardrailRow, tenantId: string, overrides: GuardrailOverrides = {}): Omit<GuardrailRow, 'created_at' | 'updated_at'> {
  const logicalKey = logicalKeyOf(global);
  const forked = { ...global, id: newUUIDv7() } as Record<string, unknown>;
  for (const c of GUARDRAIL_SEMANTIC_COLS) if (overrides[c] !== undefined) forked[c] = overrides[c];
  forked['enabled'] = global.enabled ?? 1;
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKey;
  forked['origin_id'] = global.id;
  forked['origin_hash'] = global.content_hash ?? '';
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  forked['content_hash'] = guardrailContentHash(forked as Partial<GuardrailRow>);
  return forked as unknown as Omit<GuardrailRow, 'created_at' | 'updated_at'>;
}
