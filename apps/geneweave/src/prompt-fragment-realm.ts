// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant PROMPT FRAGMENT content forking (Section D, item 13).
 *
 * `prompt_fragments` got its realm columns back in m151 (same migration as `prompts`), but it never got
 * the fork stack: no `buildTenantPromptFragmentFork`, no resolver, no `/realm` `/customize` routes. It
 * was the one realm-enabled family a tenant could not customize or revert. This closes that gap.
 *
 * Fragments are the reusable snippets a prompt template pulls in with `{{>key}}`, so a tenant forking a
 * fragment (say the `safety.disclaimer` boilerplate) changes every prompt that includes it — without
 * forking those prompts. `prompt_fragments.key` carries a UNIQUE constraint, so a fork is stored under
 * `key#tenant` and the resolver restores the canonical `key` on the effective row (the same aliasing
 * pattern as tool_policies / cost_policies / the prompt catalog).
 */
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { newUUIDv7 } from './lib/uuid.js';
import { realmContentHash, parseRealmSemantic, FRAGMENT_SEMANTIC_COLS } from './migrations/m151-realm-columns.js';
import type { PromptFragmentRow } from './db-types/prompts.js';

/** Recompute a fragment's content_hash over its semantic fields (matches m151; excludes key/enabled). */
export function fragmentContentHash(row: Partial<PromptFragmentRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of FRAGMENT_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a fragment (copy-on-write). */
export type PromptFragmentOverrides = Partial<Pick<PromptFragmentRow, (typeof FRAGMENT_SEMANTIC_COLS)[number]> & { share_mode: string }>;

const logicalKeyOf = (r: { logical_key?: string | null; key?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.key ?? undefined) || String(r.id ?? '');

function toFragmentRealmRecord(row: PromptFragmentRow): RealmRecord<Record<string, unknown>> {
  const raw = row as unknown as Record<string, unknown>;
  return {
    ...raw,
    id: row.id,
    realm: (raw['realm'] === 'tenant' ? 'tenant' : 'global'),
    ownerTenantId: (raw['owner_tenant_id'] as string | null) ?? null,
    logicalKey: logicalKeyOf(row),
    originId: (raw['origin_id'] as string | null) ?? null,
    originHash: (raw['origin_hash'] as string | null) ?? null,
    contentHash: String(raw['content_hash'] ?? ''),
    trackMode: (raw['track_mode'] as RealmRecord['trackMode']) ?? 'pin',
    shareMode: (raw['share_mode'] as RealmRecord['shareMode']) ?? 'private',
  };
}

/**
 * The fragments a tenant effectively sees: its own forks + ancestors' shared forks + the globals,
 * nearest-owner-wins, one per logical key. The canonical `key` is restored on a fork's effective row so
 * `{{>key}}` inclusion keeps resolving by the shared name. Null tenant → the globals only.
 */
export function resolveTenantEffectivePromptFragments(
  all: readonly PromptFragmentRow[],
  tenantId: string | null | undefined,
  ctx?: RealmContext,
): PromptFragmentRow[] {
  if (!tenantId) return all.filter((f) => ((f as unknown as Record<string, unknown>)['realm'] ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  return resolveEffective(all.map(toFragmentRealmRecord), context).map((e) => {
    const row = { ...(e as unknown as Record<string, unknown>) };
    row['key'] = (e as unknown as { logicalKey: string }).logicalKey; // restore the canonical key
    return row as unknown as PromptFragmentRow;
  });
}

/**
 * Build a tenant's fork of a global fragment. The fork takes a fresh id and a tenant-scoped
 * `key#tenant` (the table's UNIQUE(key)), while `logical_key` keeps the canonical key so resolution and
 * drift both key on the shared identity. `origin_*` records what it was forked from, for drift.
 */
export function buildTenantPromptFragmentFork(
  global: PromptFragmentRow,
  tenantId: string,
  overrides: PromptFragmentOverrides = {},
): Omit<PromptFragmentRow, 'created_at' | 'updated_at'> {
  const logicalKey = logicalKeyOf(global);
  const forked: Record<string, unknown> = { ...(global as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) forked[k] = v;

  forked['id'] = newUUIDv7();
  forked['key'] = `${logicalKey}#${tenantId}`; // UNIQUE(key) → alias the fork
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKey;
  forked['origin_id'] = global.id;
  forked['origin_hash'] = (global as unknown as Record<string, unknown>)['content_hash'] ?? fragmentContentHash(global);
  forked['content_hash'] = fragmentContentHash(forked as Partial<PromptFragmentRow>);
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  delete forked['created_at'];
  delete forked['updated_at'];
  return forked as unknown as Omit<PromptFragmentRow, 'created_at' | 'updated_at'>;
}
