// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm / Upgrade Engine — structured (node/edge) three-way merge for workflow definitions.
 *
 * A workflow's `steps` is a graph: nodes, each carrying its own wiring (the next-step ids that are its
 * outgoing edges). The generic realm field-level merge treats a semantic field as ONE atomic value, so if a
 * new release adds a node and the tenant re-wired a different node, the whole `steps` field reads as a
 * conflict — even though the two changes don't touch the same node. That is too blunt for a graph.
 *
 * This merges `steps` per node, keyed by node id, with the same three-way logic the realm engine uses per
 * field — but applied to each node independently:
 *   • a node the tenant never touched that the release changed  → take the release's node (upgrade it)
 *   • a node the tenant customised that the release didn't change → keep the tenant's node
 *   • a node the release ADDED (absent from base and tenant)     → add it (vendor node coexists)
 *   • a node the tenant ADDED (absent from base and release)     → keep it (tenant node coexists)
 *   • a node BOTH changed differently                            → a per-node conflict (kept local, flagged)
 *   • a node BOTH removed / removed-by-one                       → removal is respected; a remove-vs-edit
 *                                                                   is a conflict (kept, flagged) — never a
 *                                                                   silent drop of edited work.
 *
 * Pure and dependency-free (its own stable-stringify), so it is unit-testable and can move into
 * `@weaveintel/upgrade` alongside the field-level merge.
 */

/** One workflow node/step. Must carry a string `id`; all other properties are opaque and preserved. */
export interface WorkflowStep {
  id: string;
  [k: string]: unknown;
}

/** The result of a structured steps merge. */
export interface WorkflowMergeResult {
  /** The merged node list (order: base order first, then local-added, then remote-added — stable). */
  readonly steps: WorkflowStep[];
  /** Nodes needing a human: both sides changed a node differently, or one edited while the other removed. */
  readonly conflicts: Array<{ id: string; reason: 'both_changed' | 'edit_vs_remove' }>;
}

/** Stable JSON — object keys sorted recursively — so equality is order-independent. */
function stable(v: unknown): string {
  const seen = new WeakSet();
  const norm = (x: unknown): unknown => {
    if (x && typeof x === 'object') {
      if (seen.has(x as object)) return null; // guard cycles (workflow graphs shouldn't have them, but be safe)
      seen.add(x as object);
      if (Array.isArray(x)) return x.map(norm);
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Parse a `steps` value (JSON string or already-array) into a node list. Non-array / bad JSON → []. */
export function parseSteps(value: unknown): WorkflowStep[] {
  let arr: unknown = value;
  if (typeof value === 'string') { try { arr = JSON.parse(value); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.filter((s): s is WorkflowStep => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string');
}

/** Index a node list by id (last write wins on duplicate ids, which are malformed anyway). */
function byId(steps: WorkflowStep[]): Map<string, WorkflowStep> {
  return new Map(steps.map((s) => [s.id, s]));
}

/**
 * Three-way merge two `steps` graphs against their common base, per node.
 *
 * @param base the node list we last shipped (Base) — string or array.
 * @param local the node list in the store now (Local, may carry tenant edits) — string or array.
 * @param remote the node list this release ships (Remote) — string or array.
 * @returns the merged node list and any per-node conflicts (a conflict keeps the LOCAL node — never loses
 *   tenant work — and is surfaced for review). Pure; no side effects.
 */
export function mergeWorkflowSteps(base: unknown, local: unknown, remote: unknown): WorkflowMergeResult {
  const b = byId(parseSteps(base));
  const l = byId(parseSteps(local));
  const r = byId(parseSteps(remote));
  const ids = new Set<string>([...b.keys(), ...l.keys(), ...r.keys()]);

  const merged: WorkflowStep[] = [];
  const conflicts: WorkflowMergeResult['conflicts'] = [];
  const eq = (x?: WorkflowStep, y?: WorkflowStep) => stable(x ?? null) === stable(y ?? null);

  // Emit in a stable order: base order, then local-only additions, then remote-only additions.
  const order: string[] = [];
  for (const s of parseSteps(base)) if (ids.has(s.id)) order.push(s.id);
  for (const s of parseSteps(local)) if (!order.includes(s.id) && ids.has(s.id)) order.push(s.id);
  for (const s of parseSteps(remote)) if (!order.includes(s.id) && ids.has(s.id)) order.push(s.id);

  for (const id of order) {
    const bn = b.get(id); const ln = l.get(id); const rn = r.get(id);
    const inB = b.has(id), inL = l.has(id), inR = r.has(id);

    if (inL && inR) {
      if (eq(ln, rn)) { merged.push(ln!); continue; }             // both have the same node
      const localChanged = !inB || !eq(ln, bn);
      const remoteChanged = !inB || !eq(rn, bn);
      if (localChanged && !remoteChanged) { merged.push(ln!); continue; } // tenant customised; keep theirs
      if (!localChanged && remoteChanged) { merged.push(rn!); continue; } // untouched; take the release's
      // both changed differently → conflict, keep local (never lose tenant work)
      merged.push(ln!); conflicts.push({ id, reason: 'both_changed' });
      continue;
    }
    if (inL && !inR) {
      if (inB && !eq(ln, bn)) { merged.push(ln!); conflicts.push({ id, reason: 'edit_vs_remove' }); continue; } // remote removed a node the tenant edited → conflict, keep local
      if (inB && eq(ln, bn)) continue;   // remote removed a node the tenant didn't touch → honour removal
      merged.push(ln!); continue;         // tenant-added node (not in base/remote) → keep it
    }
    if (!inL && inR) {
      if (inB && !eq(rn, bn)) { merged.push(rn!); conflicts.push({ id, reason: 'edit_vs_remove' }); continue; } // tenant removed a node the release changed → conflict, take release's (visible for review)
      if (inB && eq(rn, bn)) continue;   // tenant removed a node the release didn't touch → honour removal
      merged.push(rn!); continue;         // release-added node → add it (coexists with tenant graph)
    }
    // inB only → both removed → drop.
  }
  return { steps: merged, conflicts };
}

/** A structured-field merger as `realm-diff`'s autoMerge expects: returns the merged value + conflict keys. */
export type StructuredFieldMerger = (base: unknown, local: unknown, remote: unknown) => { value: unknown; conflicts: string[] };

/** Merge the `steps` field: JSON string in, JSON string out, per-node conflicts reported as `steps.<id>`. */
export const mergeStepsField: StructuredFieldMerger = (base, local, remote) => {
  const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
  return { value: JSON.stringify(steps), conflicts: conflicts.map((c) => `steps.${c.id}`) };
};

/**
 * The structured-field mergers for a realm family, keyed by field name. Only `workflows.steps` today.
 * `realm-diff`'s autoMerge consults this so a workflow's node graph merges per node instead of all-or-nothing.
 * @param family the realm family string.
 * @returns a map field → merger, or undefined if the family has no structured fields.
 */
export function structuredFieldsFor(family: string): Record<string, StructuredFieldMerger> | undefined {
  if (family === 'workflows') return { steps: mergeStepsField };
  return undefined;
}
