/** Prompt and prompt-sub-entity row types. */

export interface PromptRow {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  category: string | null;
  prompt_type: string;
  owner: string | null;
  status: string;
  tags: string | null;            // JSON array
  template: string;
  variables: string | null;       // JSON PromptVariable[]
  version: string;
  model_compatibility: string | null; // JSON object
  execution_defaults: string | null;  // JSON object
  framework: string | null;       // JSON object
  metadata: string | null;        // JSON object
  is_default: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * A named, ordered prompt section structure stored in the `prompt_frameworks` table.
 * Rows are loaded at runtime into an InMemoryFrameworkRegistry via frameworkFromRecord().
 */
export interface PromptFrameworkRow {
  id: string;
  key: string;                    // Unique short identifier, e.g. 'rtce'
  name: string;                   // Display name
  description: string | null;
  sections: string;               // JSON: PromptFrameworkSectionDef[]
  section_separator: string;      // Separator between assembled sections (default '\n\n')
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * A reusable text block stored in `prompt_fragments`, includable via `{{>key}}` syntax.
 * Rows are loaded at runtime into an InMemoryFragmentRegistry via fragmentFromRecord().
 */
export interface PromptFragmentRow {
  id: string;
  key: string;                    // Unique fragment key, referenced in templates as {{>key}}
  name: string;                   // Display name
  description: string | null;
  category: string | null;        // Organisational grouping (e.g. 'safety', 'personas')
  content: string;                // The fragment text body (may contain {{variables}})
  variables: string | null;       // JSON: FragmentVariable[]
  tags: string | null;            // JSON: string[]
  version: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Output contract stored in `prompt_contracts`. Contracts validate or enforce constraints
 * on LLM output: JSON structure, markdown sections, code quality, length, forbidden content, etc.
 * Rows are loaded at runtime into an InMemoryContractRegistry via contractFromRecord().
 */
export interface PromptContractRow {
  id: string;
  key: string;                    // Unique contract key
  name: string;                   // Display name
  description: string | null;     // Detailed description for model understanding
  contract_type: string;          // 'json' | 'markdown' | 'code' | 'max_length' | 'forbidden_content' | 'structured'
  schema: string | null;          // JSON: JSONSchema7 (for json contracts)
  config: string;                 // JSON: Contract-specific config (severity, repairHook, constraints, etc.)
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt strategy stored in `prompt_strategies`. Strategies are model-facing
 * execution overlays selected by execution_defaults.strategy.
 */
export interface PromptStrategyRow {
  id: string;
  key: string;                    // Unique strategy key, e.g. 'singlePass' or 'critiqueRevise'
  name: string;                   // Display name
  description: string | null;     // Detailed model-facing description
  instruction_prefix: string | null;
  instruction_suffix: string | null;
  config: string;                 // JSON object for strategy runtime options
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt version rows for lifecycle-safe resolution. This separates mutable
 * prompt metadata from concrete version payloads used at runtime.
 */
export interface PromptVersionRow {
  id: string;
  prompt_id: string;
  version: string;
  status: string;                // draft | published | retired
  template: string;
  variables: string | null;      // JSON PromptVariable[]
  model_compatibility: string | null;
  execution_defaults: string | null;
  framework: string | null;
  metadata: string | null;
  is_active: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt experiment rows used for deterministic variant assignment.
 */
export interface PromptExperimentRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string | null;
  status: string;                // draft | active | completed
  variants_json: string;         // JSON: [{ version, weight, label? }]
  assignment_key_template: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt evaluation datasets for Phase 7. Each dataset is attached to one
 * prompt and optionally pins a specific prompt version.
 */
export interface PromptEvalDatasetRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string | null;
  prompt_version: string | null;
  status: string;                // draft | active | archived
  pass_threshold: number;
  cases_json: string;            // JSON: PromptEvalCase[]
  rubric_json: string | null;    // JSON: PromptEvalRubricCriterion[]
  metadata: string | null;       // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Historical evaluation execution artifacts for prompt versions.
 */
export interface PromptEvalRunRow {
  id: string;
  dataset_id: string;
  prompt_id: string;
  prompt_version: string;
  status: string;                // completed | failed
  avg_score: number;
  passed_cases: number;
  failed_cases: number;
  total_cases: number;
  results_json: string;          // JSON: case-level outputs
  summary_json: string | null;   // JSON: aggregate summary
  metadata: string | null;       // JSON object
  created_at: string;
  completed_at: string | null;
}

/**
 * DB-managed prompt optimizer profiles used by app runtimes to select and
 * configure optimization engines.
 */
export interface PromptOptimizerRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  implementation_kind: string;   // rule | llm | hybrid
  config: string;                // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Historical optimization run artifacts for audit and rollback workflows.
 */
export interface PromptOptimizationRunRow {
  id: string;
  prompt_id: string;
  source_version: string;
  candidate_version: string;
  optimizer_id: string | null;
  objective: string;
  source_template: string;
  candidate_template: string;
  diff_json: string;             // JSON: normalized diff metadata
  eval_baseline_json: string | null;
  eval_candidate_json: string | null;
  status: string;                // completed | failed
  metadata: string | null;
  created_at: string;
}
