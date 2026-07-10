/**
 * Tenancy Realm (Section C10) — resolve a weaveNotes action's execution mode down the tenant lineage.
 *
 * `note_action_modes` predates the realm and used a hand-rolled two-level fallback: a tenant's own row,
 * else the `tenant_id=''` global default, else 'direct'. This consolidates that onto the shared realm
 * resolver (`resolveOne` / nearest-owner-wins), which additionally gives HIERARCHY inheritance for free:
 * a parent org can set a mode once and every child tenant inherits it (unless the child sets its own).
 * No schema change — the existing `tenant_id` column is the owner (`''` = global), `action_key` is the
 * logical key. Tenant rows are mapped as shared to the subtree so a parent's choice flows to children.
 */
import { resolveOne, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import type { NoteActionModeRow } from './db-types/adapter-me.js';

export type NoteActionMode = 'direct' | 'agent' | 'supervisor';
const normalize = (m: string | undefined): NoteActionMode => (m === 'agent' || m === 'supervisor' ? m : 'direct');

/** Map a note_action_modes row into a realm record. `tenant_id=''` (or null) → the global default. */
function toRealmRecord(r: NoteActionModeRow): RealmRecord<{ mode: string }> {
  const owner = r.tenant_id && r.tenant_id !== '' ? r.tenant_id : null;
  return {
    id: r.id,
    realm: owner ? 'tenant' : 'global',
    ownerTenantId: owner,
    logicalKey: r.action_key,
    originId: null,
    originHash: null,
    contentHash: `mode:${r.mode}`,
    trackMode: 'pin',
    // A tenant's mode is shared down its subtree, so a parent org's choice inherits to child tenants
    // (the realm's nearest-owner-wins still lets a child override with its own row).
    shareMode: owner ? 'subtree' : 'private',
    mode: r.mode,
  };
}

/**
 * The effective mode for one action, resolved nearest-owner-wins: the tenant's own row → the nearest
 * ancestor org's row → the global default (`tenant_id=''`) → 'direct'. `rowsForAction` is every row for
 * this `actionKey` across all owners (a tiny set). With no tenant, only the global default is considered.
 */
export function resolveTenantEffectiveNoteActionMode(
  rowsForAction: readonly NoteActionModeRow[],
  actionKey: string,
  tenantId: string | null | undefined,
  ctx?: RealmContext,
): NoteActionMode {
  if (!rowsForAction.length) return 'direct';
  if (!tenantId) {
    const g = rowsForAction.find((r) => !r.tenant_id || r.tenant_id === '');
    return normalize(g?.mode);
  }
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const eff = resolveOne(rowsForAction.map(toRealmRecord), actionKey, context);
  return normalize((eff as { mode?: string } | null)?.mode);
}
