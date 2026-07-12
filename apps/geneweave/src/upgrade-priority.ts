// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the priority scorer for review items.
 *
 * The banding MECHANISM (bands, the collision/conflict→top-band rule, `needsReview`) lives in
 * `@weaveintel/upgrade`. This module supplies geneWeave's POLICY — which config family sits in which band —
 * and wires it to the mechanism, keeping the app-facing `upgradePriority(family, disposition)` API that
 * `upgrade-run-store` and `realm-seed-reconcile` already call.
 *
 * Bands (P1 highest): P1 guardrails/auth + any collision/conflict · P2 skills/workflows/worker agents ·
 * P3 tool/routing/cost policies + prompt catalog + registry config · P4 capability scores/task types ·
 * P5 model pricing/labels.
 */
import { bandFor, needsReview, type UpgradePriority, type UpgradeDisposition } from '@weaveintel/upgrade';

// Re-export the shared types + the review predicate so existing importers are unchanged.
export { needsReview, type UpgradePriority, type UpgradeDisposition };

/** geneWeave's family → base priority policy. Families not listed default to P3 (operational config). */
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
 * Priority band for a review item — geneWeave's family policy applied through the shared mechanism. A
 * collision or genuine both-sides conflict is always P1 regardless of family; otherwise the family's band,
 * or P3 for an unlisted family.
 *
 * @param family the realm family string (e.g. 'skills', 'guardrails').
 * @param disposition what the pass decided about the record.
 * @returns the priority band.
 */
export function upgradePriority(family: string, disposition: UpgradeDisposition): UpgradePriority {
  return bandFor(family, disposition, FAMILY_PRIORITY);
}
