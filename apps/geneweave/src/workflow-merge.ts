// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm / Upgrade Engine — structured (node/edge) three-way merge for workflow definitions.
 *
 * A workflow's `steps` is a graph: nodes, each carrying its own wiring. Merging it as one atomic field
 * would make a release adding a node conflict with a tenant re-wiring a DIFFERENT node. The engine-generic
 * per-element merge for any id-keyed list lives in `@weaveintel/upgrade` (`mergeKeyedList`); this module is
 * geneWeave's thin workflow-specific view of it — the `steps`/`id` shape, the `mergeStepsField` adapter
 * that `realm-diff.autoMerge` consults, and the family→structured-field map — so callers and tests are
 * unchanged while the merge logic is shared.
 */
import { mergeKeyedList, parseList } from '@weaveintel/upgrade';

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

/** Parse a `steps` value (JSON string or already-array) into a node list. Non-array / bad JSON → []. */
export function parseSteps(value: unknown): WorkflowStep[] {
  return parseList<WorkflowStep>(value, 'id');
}

/**
 * Three-way merge two `steps` graphs against their common base, per node — geneWeave's workflow view of the
 * generic {@link mergeKeyedList}.
 *
 * @param base the node list we last shipped (Base) — string or array.
 * @param local the node list in the store now (Local, may carry tenant edits) — string or array.
 * @param remote the node list this release ships (Remote) — string or array.
 * @returns the merged node list (`steps`) and any per-node conflicts (a conflict keeps the LOCAL node —
 *   never loses tenant work — and is surfaced for review). Pure; no side effects.
 */
export function mergeWorkflowSteps(base: unknown, local: unknown, remote: unknown): WorkflowMergeResult {
  const { items, conflicts } = mergeKeyedList<WorkflowStep>(base, local, remote, 'id');
  return { steps: items, conflicts };
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
