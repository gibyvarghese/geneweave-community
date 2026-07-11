// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the release's shipped realm defaults, gathered per family.
 *
 * The seed-reconcile step needs each family's *desired* defaults (the Remote leg) as data so it can
 * publish them into `realm_versions` and compare them against what the operator has. This module is the
 * single place those defaults are collected, so there is one source of truth per family shared by the
 * insert-if-missing seed and the reconcile.
 *
 * Coverage today:
 *   • `skills` — the built-in library from `@weaveintel/skills` (`BUILT_IN_SKILLS` → `mapSkillToRow`), the
 *     motivating family: a shipped skill whose instructions change in a new release is adopted on an
 *     untouched install and kept-and-flagged where the operator customised it.
 *   • `prompts` — handled by `reconcilePromptRealm` inside `seedDefaultData` (it already has the prompt
 *     seed array in scope), so it is intentionally NOT re-listed here; the whole-registry pass baselines
 *     it as a no-op.
 *
 * Every OTHER registered family is covered baseline-only for now (its global rows get a `realm_versions`
 * baseline so it participates in drift going forward). Wiring a family's shipped defaults here is the
 * single, additive step that upgrades it from baseline-only to full stale-adoption — no engine change.
 */
import { BUILT_IN_SKILLS, mapSkillToRow } from '@weaveintel/skills';
import type { RealmSeedDefaults, RealmDefault } from './realm-seed-reconcile.js';

/**
 * Collect the release's shipped defaults, keyed by realm family.
 * @returns a map of family → shipped default rows for families with wired defaults. Families absent from
 *          the map are reconciled baseline-only. Pure (no DB access): the defaults are compiled-in data.
 */
export function collectRealmSeedDefaults(): RealmSeedDefaults {
  return {
    // `mapSkillToRow` yields a row carrying every SKILL_SEMANTIC_COLS field (name, description, category,
    // trigger_patterns, instructions, tool_names, examples, tags, domain_sections, execution_contract) plus
    // the id used as the skills logical key — exactly what the reconcile hashes and keys on.
    skills: BUILT_IN_SKILLS.map((s) => mapSkillToRow(s) as unknown as RealmDefault),
  };
}
