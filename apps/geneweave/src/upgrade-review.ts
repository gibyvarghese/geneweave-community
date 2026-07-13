// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the REVIEW QUEUE engine behind the Upgrade Center.
 *
 * After an apply, the records it couldn't resolve automatically (genuine conflicts, collisions, deferrals,
 * operator-customised defaults) sit as unresolved `upgrade_details` rows. This module is the server-side logic
 * the review queue drives: list what's outstanding, and resolve each item one of three ways —
 *
 *   • keep-mine    — the operator's version stands; just mark it resolved (no data change).
 *   • adopt-incoming — take the shipped upstream wholesale (via the field-level merge engine, remote-wins),
 *                      after snapshotting the prior row state so the action is UNDOABLE.
 *   • defer        — leave the record as-is, mark it deferred with an optional comment.
 *
 * Plus a bounded BULK path with a hard guardrail (a P1 item — a guardrail change or a genuine conflict — is
 * NEVER resolved in bulk; it must be handled individually) and per-item UNDO (re-open the item, and for an
 * adopt, restore the exact pre-adopt row from the captured snapshot).
 *
 * It reuses, not reinvents: the field-level three-way diff/merge (`realm-diff.ts`), the family registry +
 * live-row fetch (`realm-families` / `realm-seed-reconcile`), and the run/detail store (`upgrade-run-store`).
 * Written once against the framework's `SqlClient` seam so it serves SQLite and Postgres.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph } from './realm-sql.js';
import { isRealmFamily, realmFamily } from './realm-families.js';
import { fetchGlobalRealmRow } from './realm-seed-reconcile.js';
import { loadThreeWayDiff, applyRealmMerge } from './realm-diff.js';
import {
  listUnresolvedUpgradeDetails, getUpgradeDetail, resolveUpgradeDetail, unresolveUpgradeDetail,
  setUpgradeDetailUndo, type UpgradeDetailRow,
} from './upgrade-run-store.js';

/** The three per-item review actions. */
export type ReviewAction = 'keep' | 'adopt' | 'defer';
/** The resolution string persisted for each action. */
const RESOLUTION: Record<ReviewAction, string> = { keep: 'kept', adopt: 'adopted', defer: 'deferred' };

/** The outcome of resolving (or undoing) one item. */
export interface ReviewResult {
  readonly ok: boolean;
  readonly detailId: string;
  readonly action?: ReviewAction;
  readonly reason?: string;
}

/** The review queue: the outstanding items plus tallies for the UI's grouping. */
export interface ReviewQueue {
  readonly items: UpgradeDetailRow[];
  readonly byPriority: Record<string, number>;
  readonly byFamily: Record<string, number>;
}

/**
 * The current review queue — every unresolved item, P1→P5 then newest, with tallies.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param filter optional { family, priority } narrowing.
 * @returns the items + by-priority / by-family counts.
 */
export async function getReviewQueue(client: SqlClient, dialect: SqlDialect, filter: { family?: string; priority?: string } = {}): Promise<ReviewQueue> {
  const items = await listUnresolvedUpgradeDetails(client, dialect, filter);
  const byPriority: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  for (const it of items) {
    byPriority[it.priority] = (byPriority[it.priority] ?? 0) + 1;
    byFamily[it.family] = (byFamily[it.family] ?? 0) + 1;
  }
  return { items, byPriority, byFamily };
}

/** The semantic + hash columns captured for undo (so an adopt can be reverted verbatim). */
function undoColumns(family: string): string[] {
  return [...realmFamily(family).semanticCols, 'content_hash', 'origin_hash'];
}

/**
 * Resolve one review item.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the upgrade_details row id.
 * @param action 'keep' | 'adopt' | 'defer'.
 * @param opts.resolvedBy who resolved it (a user id / 'automation').
 * @param opts.comment an optional note (used by defer).
 * @returns a {@link ReviewResult}. Side effects: marks the detail resolved; for `adopt`, overwrites the live
 *   record with the shipped default (re-baselined) and stores the pre-adopt snapshot for undo.
 */
export async function resolveReviewItem(
  client: SqlClient, dialect: SqlDialect, detailId: string, action: ReviewAction,
  opts: { resolvedBy?: string | null; comment?: string } = {},
): Promise<ReviewResult> {
  const detail = await getUpgradeDetail(client, dialect, detailId);
  if (!detail) return { ok: false, detailId, reason: 'item not found' };
  if (detail.resolution) return { ok: false, detailId, reason: 'item already resolved' };

  if (action === 'adopt') {
    // Only realm-content families have a live record to overwrite; L1/L2/L3/verify rows can only be kept/deferred.
    if (!isRealmFamily(detail.family)) return { ok: false, detailId, reason: `family '${detail.family}' has no adoptable record (non-content layer)` };
    const spec = realmFamily(detail.family);
    const row = await fetchGlobalRealmRow(client, dialect, spec, detail.logical_key);
    if (!row) return { ok: false, detailId, reason: 'no live record to adopt onto' };
    const recordId = String(row['id']);

    // Snapshot the exact prior row state (semantic cols + both hashes) so the adopt is undoable.
    const undo: Record<string, unknown> = {};
    for (const c of undoColumns(detail.family)) undo[c] = row[c] ?? null;

    // Adopt = take upstream for EVERY field. The merge engine re-baselines origin_hash to upstream (→ in_sync).
    const diff = await loadThreeWayDiff(client, dialect, detail.family, recordId);
    if ('error' in diff) return { ok: false, detailId, reason: diff.error };
    if (!diff.hashes.remote) return { ok: false, detailId, reason: 'nothing to adopt (no upstream version)' };
    const resolved = Object.fromEntries(diff.fields.map((f) => [f.field, f.remote]));
    const merge = await applyRealmMerge(client, dialect, detail.family, recordId, resolved);
    if (!merge.ok) return { ok: false, detailId, reason: merge.reason };

    await setUpgradeDetailUndo(client, dialect, detailId, JSON.stringify(undo));
    await resolveUpgradeDetail(client, dialect, detailId, { resolution: RESOLUTION.adopt, resolvedBy: opts.resolvedBy ?? null });
    return { ok: true, detailId, action };
  }

  // keep / defer — no data change. Defer records the operator's comment alongside the release note.
  if (action === 'defer' && opts.comment) {
    await client.query(
      `UPDATE upgrade_details SET note = COALESCE(note, '') || ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`,
      [` [deferred: ${opts.comment}]`, detailId],
    );
  }
  await resolveUpgradeDetail(client, dialect, detailId, { resolution: RESOLUTION[action], resolvedBy: opts.resolvedBy ?? null });
  return { ok: true, detailId, action };
}

/** The result of a bulk resolve: how many were resolved, and what was deliberately skipped. */
export interface BulkReviewResult {
  readonly resolved: number;
  /** P1 items are NEVER resolved in bulk (must be handled individually) — this counts those skipped. */
  readonly skippedP1: number;
  /** Items whose individual resolve failed (e.g. no upstream to adopt). */
  readonly failed: number;
}

/**
 * Bulk-resolve every unresolved item matching a filter with one action — with a HARD guardrail: a P1 item is
 * never touched in bulk, even if it matches the filter. So "adopt all stale", "keep-mine for this family", or
 * "adopt P4/P5" are safe, and a guardrail change or genuine conflict can never be swept up.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param action the action to apply to each matched non-P1 item.
 * @param filter { family, priority } narrowing (priority 'P1' is rejected outright — you cannot bulk P1).
 * @param opts.resolvedBy who resolved them.
 * @returns counts of resolved / skipped-P1 / failed.
 */
export async function bulkResolveReview(
  client: SqlClient, dialect: SqlDialect, action: ReviewAction,
  filter: { family?: string; priority?: string } = {}, opts: { resolvedBy?: string | null } = {},
): Promise<BulkReviewResult> {
  // Refuse a bulk explicitly scoped to P1 — the guardrail is a rule, not a filter to be worked around.
  if (filter.priority === 'P1') {
    const p1 = await listUnresolvedUpgradeDetails(client, dialect, filter);
    return { resolved: 0, skippedP1: p1.length, failed: 0 };
  }
  const items = await listUnresolvedUpgradeDetails(client, dialect, filter);
  let resolved = 0, skippedP1 = 0, failed = 0;
  for (const item of items) {
    if (item.priority === 'P1') { skippedP1++; continue; } // hard guardrail
    const r = await resolveReviewItem(client, dialect, item.id, action, { resolvedBy: opts.resolvedBy ?? null });
    if (r.ok) resolved++; else failed++;
  }
  return { resolved, skippedP1, failed };
}

/**
 * Undo a resolved item — re-open it in the queue, and if it was an `adopt`, restore the exact pre-adopt row
 * from the captured snapshot (so a badge that read "adopted / in-sync" truthfully returns to its prior drift).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param detailId the resolved detail to undo.
 * @returns a {@link ReviewResult}. Side effects: clears the resolution; for an adopt, a live-row restore.
 */
export async function undoReviewItem(client: SqlClient, dialect: SqlDialect, detailId: string): Promise<ReviewResult> {
  const detail = await getUpgradeDetail(client, dialect, detailId);
  if (!detail) return { ok: false, detailId, reason: 'item not found' };
  if (!detail.resolution) return { ok: false, detailId, reason: 'item is not resolved' };

  if (detail.resolution === RESOLUTION.adopt && detail.undo_json && isRealmFamily(detail.family)) {
    const spec = realmFamily(detail.family);
    const row = await fetchGlobalRealmRow(client, dialect, spec, detail.logical_key);
    if (row) {
      const undo = JSON.parse(detail.undo_json) as Record<string, unknown>;
      const cols = undoColumns(detail.family);
      const sets = cols.map((c, i) => `${c} = ${ph(dialect, i + 1)}`);
      const vals: unknown[] = cols.map((c) => undo[c] ?? null);
      vals.push(String(row['id']));
      await client.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ${ph(dialect, vals.length)}`, vals);
    }
  }
  await unresolveUpgradeDetail(client, dialect, detailId); // clears resolution + the undo snapshot
  return { ok: true, detailId };
}
