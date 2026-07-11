// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — the family registry (Section D).
 *
 * Section A wired each config family onto the realm one table at a time, each with its own
 * `*-realm.ts` module. The governance work in Section D (propose/promote, deprecate, key-collision)
 * is the SAME operation for every family, differing only in three facts: which table holds the rows,
 * which columns carry the semantic content, and how a row's logical key is derived. This registry
 * states those three facts once so the governance code can be written once instead of eleven times.
 *
 * `semanticCols` per family are the SAME arrays the migrations hash over, imported from the migration
 * that introduced them — so a promote re-hashes exactly the fields drift compares, and never drifts
 * from the migration's definition.
 */
import { PROMPT_SEMANTIC_COLS, FRAGMENT_SEMANTIC_COLS } from './migrations/m151-realm-columns.js';
import { SKILL_SEMANTIC_COLS } from './migrations/m154-realm-columns-skills.js';
import { WORKER_SEMANTIC_COLS } from './migrations/m155-realm-columns-worker-agents.js';
import { GUARDRAIL_SEMANTIC_COLS } from './migrations/m156-realm-columns-guardrails.js';
import { TOOLPOLICY_SEMANTIC_COLS } from './migrations/m157-realm-columns-tool-policies.js';
import { ROUTING_SEMANTIC_COLS, COST_SEMANTIC_COLS } from './migrations/m158-realm-columns-routing-cost.js';
import { STRATEGY_SEMANTIC_COLS, CONTRACT_SEMANTIC_COLS, FRAMEWORK_SEMANTIC_COLS } from './migrations/m159-realm-columns-prompt-catalog.js';
import { WORKFLOW_SEMANTIC_COLS } from './migrations/m164-realm-columns-workflows.js';
import { MODEL_PRICING_SEMANTIC_COLS, TASK_TYPE_SEMANTIC_COLS, PROVIDER_TOOL_ADAPTER_SEMANTIC_COLS } from './migrations/m165-realm-columns-model-catalog.js';
import { LIVE_HANDLER_KIND_SEMANTIC_COLS, LIVE_ATTENTION_POLICY_SEMANTIC_COLS } from './migrations/m166-realm-columns-live-registries.js';
import { SCAFFOLD_TEMPLATE_SEMANTIC_COLS } from './migrations/m167-realm-columns-templates.js';

/**
 * How a family derives the logical key from a row: the NAME OF THE COLUMN the logical key falls back to
 * when the stored `logical_key` column is empty. Usually the family's natural key — `key`, `name`, `id`,
 * or another single column such as `task_key` / `provider` / `kind`. The stored `logical_key` column
 * always wins when present (the migration backfills it, including composite keys as a concatenation); this
 * is only the fallback, spliced into SQL as a column name, so it must be a real column and never user input.
 */
export type LogicalKeySource = string;

export interface RealmFamilySpec {
  /** The `family` string used in realm_versions / realm_tenant_state / realm_proposals. */
  readonly family: string;
  /** The SQL table holding the rows. */
  readonly table: string;
  /** Columns that make up the content hash (identity + `enabled` deliberately excluded). */
  readonly semanticCols: readonly string[];
  /** Fallback for logical_key when the column is empty. */
  readonly logicalKeyFrom: LogicalKeySource;
}

/** Every realm-enabled family, keyed by its `family` string. */
export const REALM_FAMILIES: Readonly<Record<string, RealmFamilySpec>> = Object.freeze({
  prompts:            { family: 'prompts',            table: 'prompts',            semanticCols: PROMPT_SEMANTIC_COLS,    logicalKeyFrom: 'key'  },
  // NB fragments hash `content` (not `template`) and have no model/execution/framework columns.
  prompt_fragments:   { family: 'prompt_fragments',   table: 'prompt_fragments',   semanticCols: FRAGMENT_SEMANTIC_COLS,  logicalKeyFrom: 'key'  },
  skills:             { family: 'skills',             table: 'skills',             semanticCols: SKILL_SEMANTIC_COLS,     logicalKeyFrom: 'id'   },
  worker_agents:      { family: 'worker_agents',      table: 'worker_agents',      semanticCols: WORKER_SEMANTIC_COLS,    logicalKeyFrom: 'name' },
  guardrails:         { family: 'guardrails',         table: 'guardrails',         semanticCols: GUARDRAIL_SEMANTIC_COLS, logicalKeyFrom: 'name' },
  tool_policies:      { family: 'tool_policies',      table: 'tool_policies',      semanticCols: TOOLPOLICY_SEMANTIC_COLS, logicalKeyFrom: 'key' },
  routing_policies:   { family: 'routing_policies',   table: 'routing_policies',   semanticCols: ROUTING_SEMANTIC_COLS,   logicalKeyFrom: 'name' },
  cost_policies:      { family: 'cost_policies',      table: 'cost_policies',      semanticCols: COST_SEMANTIC_COLS,      logicalKeyFrom: 'key'  },
  prompt_strategies:  { family: 'prompt_strategies',  table: 'prompt_strategies',  semanticCols: STRATEGY_SEMANTIC_COLS,  logicalKeyFrom: 'key'  },
  prompt_contracts:   { family: 'prompt_contracts',   table: 'prompt_contracts',   semanticCols: CONTRACT_SEMANTIC_COLS,  logicalKeyFrom: 'key'  },
  prompt_frameworks:  { family: 'prompt_frameworks',  table: 'prompt_frameworks',  semanticCols: FRAMEWORK_SEMANTIC_COLS, logicalKeyFrom: 'key'  },
  // ── Upgrade Engine (Phase 0b): the routing/runtime catalog families ──────────────────────────────
  workflows:              { family: 'workflows',              table: 'workflow_defs',           semanticCols: WORKFLOW_SEMANTIC_COLS,               logicalKeyFrom: 'name'     },
  // model_pricing keys on the (provider, model_id) pair; the migration stores the composite in logical_key.
  model_pricing:          { family: 'model_pricing',          table: 'model_pricing',           semanticCols: MODEL_PRICING_SEMANTIC_COLS,          logicalKeyFrom: 'model_id' },
  task_type_definitions:  { family: 'task_type_definitions',  table: 'task_type_definitions',   semanticCols: TASK_TYPE_SEMANTIC_COLS,              logicalKeyFrom: 'task_key' },
  provider_tool_adapters: { family: 'provider_tool_adapters', table: 'provider_tool_adapters',  semanticCols: PROVIDER_TOOL_ADAPTER_SEMANTIC_COLS,  logicalKeyFrom: 'provider' },
  live_handler_kinds:     { family: 'live_handler_kinds',     table: 'live_handler_kinds',      semanticCols: LIVE_HANDLER_KIND_SEMANTIC_COLS,      logicalKeyFrom: 'kind'     },
  live_attention_policies:{ family: 'live_attention_policies',table: 'live_attention_policies', semanticCols: LIVE_ATTENTION_POLICY_SEMANTIC_COLS,  logicalKeyFrom: 'key'      },
  scaffold_templates:     { family: 'scaffold_templates',     table: 'scaffold_templates',      semanticCols: SCAFFOLD_TEMPLATE_SEMANTIC_COLS,      logicalKeyFrom: 'name'     },
  // NB model_capability_scores is intentionally NOT registered here: it already carries a tenant_id owner
  // and a bespoke resolver (capability-score-realm.ts) keyed on (provider, model_id, task_key). Folding it
  // onto the standard owner_tenant_id + single-logical-key pattern is a resolver-convergence change tracked
  // separately, not a mechanical registration.
});

/**
 * True if `family` names a realm-enabled family. An OWN-property check, not a truthy lookup: `family`
 * arrives from request bodies, and a bare `REALM_FAMILIES[family]` would happily resolve inherited keys
 * like `toString` or `constructor` off `Object.prototype` and pass a truthiness test.
 */
export const isRealmFamily = (family: string): boolean => Object.hasOwn(REALM_FAMILIES, family);

/** Look up a family, or throw a caller-friendly error naming the valid ones. Safe for untrusted input. */
export function realmFamily(family: string): RealmFamilySpec {
  if (!isRealmFamily(family)) throw new Error(`unknown realm family '${family}' (expected one of: ${Object.keys(REALM_FAMILIES).join(', ')})`);
  return REALM_FAMILIES[family]!;
}

/** The logical key of a row in `spec`'s family — the stored column, else the family's fallback source. */
export function logicalKeyOfRow(spec: RealmFamilySpec, row: Record<string, unknown>): string {
  const stored = row['logical_key'];
  if (typeof stored === 'string' && stored !== '') return stored;
  const fallback = row[spec.logicalKeyFrom];
  return String(fallback ?? row['id'] ?? '');
}
