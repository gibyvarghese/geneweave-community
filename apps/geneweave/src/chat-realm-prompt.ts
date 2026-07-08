/**
 * Tenancy Realm — resolve the tenant-effective prompt.
 *
 * A prompt in `prompts` is a *global original* (realm='global') until a tenant forks its own copy
 * (realm='tenant', same logical_key, owner_tenant_id set). When a chat runs for a tenant, we want
 * that tenant's fork if it has one, otherwise the global default — "nearest owner wins". This module
 * is the thin bridge between the app's PromptRow and `@weaveintel/realm`'s pure resolver: it maps the
 * realm columns m151 added onto each row into a RealmRecord, then asks the resolver for the winner.
 *
 * It reuses the published resolver — no override logic is duplicated here. Tenants are currently flat
 * roots (m150), so we build a depth-0 context directly; when the tenant tree gains sharing, swap the
 * context builder for `buildRealmContext(hierarchy, tenantId)` and parent-shared forks resolve for free.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveOne, type RealmRecord, type RealmProvenance, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import type { PromptRow } from './db-types/prompts.js';

/** The semantic columns that define a prompt's content_hash — identical to m151's prompts hash set. */
const PROMPT_SEMANTIC_COLS = [
  'name', 'description', 'category', 'template', 'variables', 'model_compatibility', 'execution_defaults', 'framework',
] as const;

/** Recompute a prompt row's content_hash over its semantic fields (matches m151 byte-for-byte). */
export function promptContentHash(row: Partial<PromptRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of PROMPT_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a prompt (copy-on-write). */
export type PromptOverrides = Partial<
  Pick<PromptRow, 'name' | 'description' | 'category' | 'template' | 'variables' | 'model_compatibility' | 'execution_defaults' | 'framework' | 'share_mode'>
>;

/**
 * Build a tenant's copy-on-write fork of a GLOBAL prompt: a new row that remembers where it came from
 * (origin_id + origin_hash) so drift is detectable, carries the tenant's overrides, and is stamped with
 * a fresh content_hash. Does not touch the DB — the caller persists it via insertRealmPromptRow.
 */
export function buildTenantPromptFork(
  global: PromptRow,
  tenantId: string,
  overrides: PromptOverrides = {},
): Omit<PromptRow, 'created_at' | 'updated_at'> {
  const logicalKey = global.logical_key ?? global.key ?? global.id;
  const forked: Omit<PromptRow, 'created_at' | 'updated_at'> = {
    ...global,
    id: newUUIDv7(),
    // Apply overrides over the global's payload.
    name: overrides.name ?? global.name,
    description: overrides.description ?? global.description,
    category: overrides.category ?? global.category,
    template: overrides.template ?? global.template,
    variables: overrides.variables ?? global.variables,
    model_compatibility: overrides.model_compatibility ?? global.model_compatibility,
    execution_defaults: overrides.execution_defaults ?? global.execution_defaults,
    framework: overrides.framework ?? global.framework,
    // A tenant fork is never the global default.
    is_default: 0,
    enabled: 1,
    // Realm columns: this is the tenant's private copy of `logicalKey`, forked from the global.
    realm: 'tenant',
    owner_tenant_id: tenantId,
    logical_key: logicalKey,
    origin_id: global.id,
    origin_hash: global.content_hash ?? '',
    track_mode: 'pin',
    share_mode: overrides.share_mode ?? 'private',
    content_hash: '', // set below over the forked payload
  };
  forked.content_hash = promptContentHash(forked);
  return forked;
}

/** A flat root context for a tenant (depth 0). Matches how m150 seeds tenants as roots. */
function rootContext(tenantId: string): RealmContext {
  return { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
}

/** Map a PromptRow's realm columns onto the RealmRecord shape the resolver reads. */
function toRealmRecord(row: PromptRow): RealmRecord<Record<string, unknown>> {
  return {
    ...(row as unknown as Record<string, unknown>),
    id: row.id,
    realm: row.realm === 'tenant' ? 'tenant' : 'global',
    ownerTenantId: row.owner_tenant_id ?? null,
    logicalKey: row.logical_key ?? row.key ?? row.id,
    originId: row.origin_id ?? null,
    originHash: row.origin_hash ?? null,
    contentHash: row.content_hash ?? '',
    trackMode: row.track_mode === 'track_latest' ? 'track_latest' : 'pin',
    shareMode:
      row.share_mode === 'children' ? 'children' : row.share_mode === 'subtree' ? 'subtree' : 'private',
  };
}

export interface TenantEffectivePrompt {
  /** The winning prompt row for this tenant (its own fork, or the global default). */
  row: PromptRow;
  /** How it was reached — stamped into run traces so "which prompt for which tenant?" is answerable. */
  provenance: RealmProvenance;
}

/**
 * Given every prompt row (the `SELECT * FROM prompts` the caller already has) and the base match a
 * caller found by id/name, return the row that should actually run for `tenantId` — the tenant's own
 * fork if present, else the global original — plus provenance. Returns the base match unchanged when
 * there's no tenant (global chats) or the schema predates m151 (no logical_key).
 */
export function resolveTenantEffectivePrompt(
  allRows: readonly PromptRow[],
  baseMatch: PromptRow,
  tenantId: string | null | undefined,
): TenantEffectivePrompt {
  const logicalKey = baseMatch.logical_key ?? baseMatch.key ?? baseMatch.id;
  if (!tenantId || !logicalKey) {
    return { row: baseMatch, provenance: { kind: 'global' } };
  }

  // Only rows sharing this logical key can win — the global original + any tenant forks of it.
  const candidates = allRows.filter((r) => (r.logical_key ?? r.key ?? r.id) === logicalKey && r.enabled);
  const records = candidates.map(toRealmRecord);

  // Drift needs the origin's *current* hash; build it from the rows we already have.
  const hashById = new Map(candidates.map((r) => [r.id, r.content_hash ?? '']));
  const remoteHashOf = (originId: string): string | null => hashById.get(originId) ?? null;

  const effective = resolveOne(records, logicalKey, rootContext(tenantId), remoteHashOf);
  if (!effective) return { row: baseMatch, provenance: { kind: 'global' } };

  // EffectiveRecord spreads the row back out; recover the plain PromptRow to hand downstream.
  const { realmProvenance, ...row } = effective;
  return { row: row as unknown as PromptRow, provenance: realmProvenance };
}
