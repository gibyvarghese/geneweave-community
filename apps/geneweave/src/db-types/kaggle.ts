/** Hypothesis validation and Kaggle competition row types. */

// ─── Hypothesis Validation row types ────────────────────────

/**
 * A budget envelope caps LLM cost, sandbox cost, wall-clock time, and deliberation
 * rounds for one hypothesis validation run. Never mutated after use.
 */
export interface SvBudgetEnvelopeRow {
  id: string;                         // uuid v7
  tenant_id: string;
  name: string;
  max_llm_cents: number;              // max LLM cost in US cents
  max_sandbox_cents: number;          // max container compute cost in US cents
  max_wall_seconds: number;           // wall-clock timeout seconds
  max_rounds: number;                 // max deliberation rounds
  diminishing_returns_epsilon: number; // halt when CI improvement < epsilon
  created_at: string;
}

/** Status of a hypothesis validation run. */
export type SvHypothesisStatus = 'queued' | 'running' | 'verdict' | 'abandoned';

/**
 * A hypothesis submitted for multi-agent validation.
 */
export interface SvHypothesisRow {
  id: string;                         // uuid v7
  tenant_id: string;
  submitted_by: string;               // user id
  title: string;
  statement: string;
  domain_tags: string;                // JSON: string[]
  status: SvHypothesisStatus;
  budget_envelope_id: string;         // FK → hv_budget_envelope.id
  workflow_run_id: string | null;
  trace_id: string | null;            // @weaveintel/observability/replay trace
  contract_id: string | null;         // @weaveintel/core/contracts completion contract
  created_at: string;
  updated_at: string;
}

/** The type of claim for a sub-claim. */
export type SvClaimType = 'mechanism' | 'epidemiological' | 'mathematical' | 'dose_response' | 'causal' | 'other';

/**
 * A sub-claim decomposed from a hypothesis by the Decomposer agent.
 */
export interface SvSubClaimRow {
  id: string;
  tenant_id: string;
  hypothesis_id: string;              // FK → hv_hypothesis.id ON DELETE CASCADE
  parent_sub_claim_id: string | null; // self-ref for nested decomposition
  statement: string;
  claim_type: SvClaimType;
  testability_score: number;          // 0–1 float
  created_at: string;
}

/** The possible verdicts a Supervisor can emit. */
export type SvVerdictValue = 'supported' | 'refuted' | 'inconclusive' | 'ill_posed' | 'out_of_scope';

/**
 * Supervisor-emitted verdict for a completed hypothesis run.
 * Invariant: confidence_lo <= confidence_hi.
 * Invariant: supported/refuted verdicts must cite ≥1 sandbox-tool evidence item.
 */
export interface SvVerdictRow {
  id: string;
  tenant_id: string;
  hypothesis_id: string;              // FK → hv_hypothesis.id ON DELETE CASCADE (UNIQUE)
  verdict: SvVerdictValue;
  confidence_lo: number;              // 0–1 float
  confidence_hi: number;              // 0–1 float, ≥ confidence_lo
  key_evidence_ids: string;           // JSON: string[]
  falsifiers: string;                 // JSON: string[]
  limitations: string;
  contract_id: string;
  replay_trace_id: string;
  emitted_by: string;                 // default 'supervisor'
  created_at: string;
}

export interface SvEvidenceEventRow {
  id: string;                         // UUID
  hypothesis_id: string;             // FK → hv_hypothesis.id
  step_id: string;                   // workflow step that emitted this (e.g. 'statistical')
  agent_id: string;                  // agent name
  evidence_id: string;               // contract evidence item id
  kind: string;                      // 'stat_finding' | 'lit_hit' | 'sim_result' | etc.
  summary: string;
  source_type: string;               // 'sandbox_tool_run' | 'http_fetch' | 'model_inference'
  tool_key: string | null;
  reproducibility_hash: string | null;
  created_at: string;
}

export interface SvAgentTurnRow {
  id: string;                         // UUID
  hypothesis_id: string;             // FK → hv_hypothesis.id
  round_index: number;
  from_agent: string;
  to_agent: string | null;           // null = broadcast
  message: string;
  cites_evidence_ids: string;        // JSON: string[]
  dissent: number;                   // 0 | 1 (boolean)
  created_at: string;
}

// ─── Phase K3: Kaggle projection rows ────────────────────────
// Source of truth for evidence + agent decisions remains
// @weaveintel/core/contracts and live-agents StateStore. These three
// rows back the GeneWeave admin UI and analytics views.

export interface KaggleCompetitionTrackedRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  title: string | null;
  category: string | null;
  deadline: string | null;
  reward: string | null;
  url: string | null;
  status: string;                   // 'watching' | 'active' | 'paused' | 'archived'
  notes: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KaggleApproachRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  summary: string;
  expected_metric: string | null;
  model: string | null;
  source_kernel_refs: string | null; // JSON string[]
  embedding: Buffer | null;
  status: string;                   // 'draft' | 'approved' | 'rejected' | 'implemented'
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KaggleRunRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  approach_id: string | null;
  contract_id: string | null;
  replay_trace_id: string | null;
  mesh_id: string | null;
  agent_id: string | null;
  kernel_ref: string | null;
  submission_id: string | null;
  public_score: number | null;
  validator_report: string | null;  // JSON snapshot
  status: string;                   // 'queued' | 'running' | 'validated' | 'submitted' | 'completed' | 'failed'
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Phase K4 — One artifact per kaggle_run row. Stores the actual
// @weaveintel/core/contracts CompletionReport JSON and the @weaveintel/observability/replay
// RunLog JSON so admin UI + replay endpoint can reconstruct deterministically.
export interface KaggleRunArtifactRow {
  id: string;
  run_id: string;
  contract_id: string;
  replay_trace_id: string;
  contract_report_json: string;     // JSON CompletionReport
  replay_run_log_json: string;      // JSON RunLog
  created_at: string;
}

// Phase K6 — per-tenant kill switch for the Kaggle discussion bot. The
// runtime checks `discussion_enabled === 1` before invoking
// `kaggle.discussions.create`. UNIQUE(tenant_id) so each tenant has at
// most one row; admin UI upserts by tenant_id.
export interface KaggleDiscussionSettingsRow {
  id: string;
  tenant_id: string;
  discussion_enabled: number;       // 0 = off (default), 1 = enabled
  notes: string | null;
  updated_at: string;
}

// Phase K6 — append-only log of every Kaggle discussion post the platform
// has executed. Source of truth for "what did the bot say in public" lives
// here for fast operator review; the underlying contract + replay trace
// remain in @weaveintel/core/contracts and @weaveintel/observability/replay.
export interface KaggleDiscussionPostRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  topic_id: string;
  parent_topic_id: string | null;
  title: string | null;
  body_preview: string | null;
  url: string | null;
  status: string;                   // 'posted' | 'failed' | 'killswitch_blocked'
  contract_id: string | null;
  replay_trace_id: string | null;
  posted_at: string;
}

// Phase K7d — Competition-agnostic submission validation rubric. Defines
// what "a good submission for this competition" means in machine-checkable
// terms (metric direction, baseline, expected file shape). One row per
// competition_ref per tenant. Auto-inferred from Kaggle metadata on first
// contact, then editable by operators.
export interface KaggleCompetitionRubricRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  metric_name: string | null;
  metric_direction: 'maximize' | 'minimize' | null;
  baseline_score: number | null;
  target_score: number | null;
  expected_row_count: number | null;
  id_column: string | null;
  id_range_min: number | null;
  id_range_max: number | null;
  target_column: string | null;
  target_type: string | null;        // 'binary' | 'multiclass' | 'continuous' | 'probability' | 'ranking' | 'other'
  expected_distribution_json: string | null;
  sample_submission_sha256: string | null;
  inference_source: string | null;   // free text describing how the rubric was derived
  auto_generated: number;             // 1 = auto-inferred, 0 = operator-authored
  inferred_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Phase K7d — Append-only ledger of every validator pass. One row per
// kernel run the validator reviews. Holds the structured pass/warn/fail
// verdict and the per-check booleans + violations so admin UX can show
// exactly why a submission was held back.
export interface KaggleValidationResultRow {
  id: string;
  run_id: string;
  competition_ref: string;
  rubric_id: string | null;
  kernel_ref: string | null;
  schema_check_passed: number | null;
  distribution_check_passed: number | null;
  baseline_check_passed: number | null;
  cv_score: number | null;
  cv_std: number | null;
  cv_metric: string | null;
  n_folds: number | null;
  predicted_distribution_json: string | null;
  violations_json: string | null;
  verdict: 'pass' | 'warn' | 'fail' | null;
  summary: string | null;
  validated_at: string | null;
  created_at: string;
}

// Phase K7d — Append-only ledger of leaderboard readbacks observed by the
// Leaderboard Observer role after the submitter pushes. cv_lb_delta is the
// reproducibility-critical signal: large gaps imply CV is mis-calibrated.
export interface KaggleLeaderboardScoreRow {
  id: string;
  run_id: string | null;
  competition_ref: string;
  submission_id: string | null;
  public_score: number | null;
  private_score: number | null;
  cv_lb_delta: number | null;
  percentile_estimate: number | null;
  rank_estimate: number | null;
  leaderboard_size: number | null;
  raw_status: string | null;
  observed_at: string | null;
  created_at: string;
}

// ─── Kaggle competition run ledger (per-run UUIDv7 isolation) ──
export type KglRunStatus = 'queued' | 'running' | 'completed' | 'abandoned' | 'failed';
export interface KglCompetitionRunRow {
  id: string;                      // UUIDv7
  tenant_id: string;
  submitted_by: string;
  competition_ref: string;
  title: string | null;
  objective: string | null;
  mesh_id: string | null;
  status: KglRunStatus;
  step_count: number;
  event_count: number;
  summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type KglRunStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export interface KglRunStepRow {
  id: string;                      // UUIDv7
  run_id: string;
  step_index: number;
  role: string;                    // e.g. 'kaggle_discoverer'
  title: string;                   // human-readable label
  description: string | null;
  agent_id: string | null;
  status: KglRunStepStatus;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  input_preview: string | null;
  output_preview: string | null;
  created_at: string;
  updated_at: string;
}

export interface KglRunEventRow {
  id: string;                      // UUIDv7
  run_id: string;
  step_id: string | null;
  kind: string;                    // 'tool_call' | 'agent_message' | 'evidence' | 'log' | ...
  agent_id: string | null;
  tool_key: string | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}
