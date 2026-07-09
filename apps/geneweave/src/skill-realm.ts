/**
 * Tenancy Realm — resolve the tenant-effective SKILL (content forking for skills).
 *
 * A built-in skill is a *global original* (realm='global') until a tenant forks its own copy
 * (realm='tenant', same logical_key = the skill id, owner_tenant_id set). When a chat runs for a tenant,
 * we want that tenant's fork of a skill if it has one, otherwise the shared global — nearest-owner-wins,
 * inheriting a parent org's shared fork. This mirrors the prompt bridge (chat-realm-prompt.ts) but for
 * skills; both are thin mappers over @weaveintel/realm's table-agnostic resolver — no resolution logic
 * is duplicated here.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { SKILL_SEMANTIC_COLS } from './migrations/m154-realm-columns-skills.js';
import type { SkillRow } from './db-types/tools.js';

/** Recompute a skill row's content_hash over its semantic fields (matches m154 byte-for-byte). */
export function skillContentHash(row: Partial<SkillRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of SKILL_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a skill (copy-on-write). */
export type SkillOverrides = Partial<Pick<SkillRow, (typeof SKILL_SEMANTIC_COLS)[number] | 'share_mode'>>;

const logicalKeyOf = (r: { logical_key?: string | null; id?: string }): string => (r.logical_key ?? undefined) || String(r.id ?? '');

/** Map a SkillRow's realm columns onto the RealmRecord shape the resolver reads. */
function toSkillRealmRecord(row: SkillRow): RealmRecord<Record<string, unknown>> {
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
 * Given every skill row (global originals + all tenant forks) and a tenant, return the ONE effective
 * skill per logical key for that tenant — its own fork if present, else a shared ancestor's, else the
 * global — using the tenant's real lineage `ctx`. Rows for other tenants are filtered out by visibility.
 * With no tenant, returns the global skills unchanged (backward-compatible for global chats).
 */
export function resolveTenantEffectiveSkills(allSkills: readonly SkillRow[], tenantId: string | null | undefined, ctx?: RealmContext): SkillRow[] {
  if (!tenantId) return allSkills.filter((s) => (s.realm ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const records = allSkills.map(toSkillRealmRecord);
  const effective = resolveEffective(records, context);
  // Recover the plain SkillRow from each winning record (drop the added realmProvenance).
  return effective.map((e) => { const { realmProvenance, ...row } = e; return row as unknown as SkillRow; });
}

/**
 * Build a tenant's copy-on-write fork of a GLOBAL skill: a new row that remembers where it came from
 * (origin_id + origin_hash) so drift is detectable, carries the tenant's overrides, and is stamped with
 * a fresh content_hash. Does not touch the DB — the caller persists it via insertRealmSkillRow.
 */
export function buildTenantSkillFork(global: SkillRow, tenantId: string, overrides: SkillOverrides = {}): Omit<SkillRow, 'created_at' | 'updated_at'> {
  const forked = { ...global, id: newUUIDv7() } as Record<string, unknown>;
  for (const c of SKILL_SEMANTIC_COLS) if (overrides[c] !== undefined) forked[c] = overrides[c];
  forked['enabled'] = 1;
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKeyOf(global);
  forked['origin_id'] = global.id;
  forked['origin_hash'] = global.content_hash ?? '';
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  forked['content_hash'] = skillContentHash(forked as Partial<SkillRow>);
  return forked as unknown as Omit<SkillRow, 'created_at' | 'updated_at'>;
}
