// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the priority scorer for review items.
 *
 * When a release reconciles its shipped defaults against an operator's install, most outcomes are safe
 * and automatic (adopt a default the operator never touched, publish a new one). What remains — a default
 * the operator customised, a genuine both-sides conflict, a namespace collision — needs a human, and not
 * all of it is equally urgent. This module assigns each review item a priority band so the review queue
 * can surface the dangerous things first and so bulk actions can be gated ("never bulk-resolve P1").
 *
 * Bands (P1 highest):
 *   • P1 — guardrails, auth, and ANY collision/conflict: getting these wrong weakens safety or breaks
 *          identity, so they are never auto-resolved and never bulk-resolved.
 *   • P2 — skills, workflows, worker agents: behavioural surface area.
 *   • P3 — tool / routing / cost policies, prompt catalog, UI/registry config: operational tuning.
 *   • P4 — capability scores, task-type catalog: routing inputs.
 *   • P5 — model pricing, labels: informational, safe to adopt in bulk.
 *
 * Pure and dependency-free so it is trivially unit-testable and can move into `@weaveintel/upgrade`.
 */

/** A review-item priority band, P1 (most urgent) to P5 (least). */
export type UpgradePriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/**
 * What a reconcile/merge pass decided about one record. Extends the realm engine's `ReconcileState`
 * (in_sync | customized | stale | diverged | new | removed) with the actions a run records and the
 * merge/queue outcomes a later step produces.
 */
export type UpgradeDisposition =
  | 'in_sync'
  | 'customized'
  | 'stale'
  | 'diverged'
  | 'new'
  | 'removed'
  | 'adopted'
  | 'published'
  | 'auto_merged'
  | 'conflict'
  | 'collision'
  | 'deferred';

/** Family → base priority. Families not listed default to P3 (operational config). */
const FAMILY_PRIORITY: Readonly<Record<string, UpgradePriority>> = Object.freeze({
  // P1 — safety/identity
  guardrails: 'P1',
  // P2 — behavioural
  skills: 'P2',
  workflows: 'P2',
  worker_agents: 'P2',
  // P3 — operational tuning
  tool_policies: 'P3',
  routing_policies: 'P3',
  cost_policies: 'P3',
  prompts: 'P3',
  prompt_fragments: 'P3',
  prompt_strategies: 'P3',
  prompt_contracts: 'P3',
  prompt_frameworks: 'P3',
  provider_tool_adapters: 'P3',
  live_handler_kinds: 'P3',
  live_attention_policies: 'P3',
  scaffold_templates: 'P3',
  // P4 — routing inputs
  task_type_definitions: 'P4',
  model_capability_scores: 'P4',
  // P5 — informational
  model_pricing: 'P5',
});

/**
 * Priority for a review item. A collision or a genuine both-sides conflict is ALWAYS P1 regardless of
 * family — a namespace collision or a lost operator edit is the most dangerous thing an upgrade can do —
 * otherwise the family's band applies.
 *
 * @param family the realm family string (e.g. 'skills', 'guardrails').
 * @param disposition what the pass decided about the record.
 * @returns the priority band. Unknown families fall back to P3.
 */
export function upgradePriority(family: string, disposition: UpgradeDisposition): UpgradePriority {
  if (disposition === 'collision' || disposition === 'conflict') return 'P1';
  return FAMILY_PRIORITY[family] ?? 'P3';
}

/** True if this disposition is one a human still needs to act on (vs a safe, already-applied move). */
export function needsReview(disposition: UpgradeDisposition): boolean {
  return (
    disposition === 'customized' ||
    disposition === 'diverged' ||
    disposition === 'conflict' ||
    disposition === 'collision' ||
    disposition === 'removed' ||
    disposition === 'deferred'
  );
}
