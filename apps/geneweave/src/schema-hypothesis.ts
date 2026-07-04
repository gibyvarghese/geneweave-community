/**
 * Hypothesis Validation (HV) — multi-agent scientific claim validation system.
 *
 * Tables: budget envelopes, hypotheses, sub-claims, verdicts, evidence events,
 * agent dialogue turns, and backward-compatible view aliases (sv_*).
 *
 * Relationships:
 *   hv_hypothesis → hv_budget_envelope
 *   hv_sub_claim → hv_hypothesis, hv_sub_claim (self-referential parent)
 *   hv_verdict → hv_hypothesis (unique, 1:1)
 *   hv_evidence_event → hv_hypothesis
 *   hv_agent_turn → hv_hypothesis
 */
export const SCHEMA_HYPOTHESIS_SQL = `
-- Budget envelopes cap cost/time for a validation run. Created once, never mutated after use.
CREATE TABLE IF NOT EXISTS hv_budget_envelope (
  id TEXT PRIMARY KEY,                       -- uuid v7
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  max_llm_cents INTEGER NOT NULL,            -- max LLM cost in US cents
  max_sandbox_cents INTEGER NOT NULL,        -- max container compute cost in US cents
  max_wall_seconds INTEGER NOT NULL,         -- wall-clock timeout
  max_rounds INTEGER NOT NULL,               -- max deliberation rounds
  diminishing_returns_epsilon REAL NOT NULL, -- halt when CI improvement < epsilon
  created_at TEXT NOT NULL
);

-- A hypothesis submitted for multi-agent validation.
CREATE TABLE IF NOT EXISTS hv_hypothesis (
  id TEXT PRIMARY KEY,                       -- uuid v7
  tenant_id TEXT NOT NULL,
  submitted_by TEXT NOT NULL,                -- user id
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  domain_tags TEXT NOT NULL,                 -- JSON: string[]
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','verdict','abandoned')),
  budget_envelope_id TEXT NOT NULL REFERENCES hv_budget_envelope(id),
  workflow_run_id TEXT,
  trace_id TEXT,                             -- @weaveintel/observability/replay trace
  contract_id TEXT,                          -- @weaveintel/core/contracts completion contract
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_tenant ON hv_hypothesis(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_status ON hv_hypothesis(tenant_id, status);

-- Sub-claims decomposed from a hypothesis by the Decomposer agent.
CREATE TABLE IF NOT EXISTS hv_sub_claim (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  parent_sub_claim_id TEXT REFERENCES hv_sub_claim(id),
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('mechanism','epidemiological','mathematical','dose_response','causal','other')),
  testability_score REAL NOT NULL CHECK (testability_score BETWEEN 0 AND 1),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_sub_claim_hypothesis ON hv_sub_claim(hypothesis_id);

-- Supervisor-emitted verdict for a completed hypothesis run.
CREATE TABLE IF NOT EXISTS hv_verdict (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL UNIQUE REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL
    CHECK (verdict IN ('supported','refuted','inconclusive','ill_posed','out_of_scope')),
  confidence_lo REAL NOT NULL CHECK (confidence_lo BETWEEN 0 AND 1),
  confidence_hi REAL NOT NULL CHECK (confidence_hi BETWEEN 0 AND 1),
  key_evidence_ids TEXT NOT NULL,  -- JSON: string[]
  falsifiers TEXT NOT NULL,        -- JSON: string[]
  limitations TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  replay_trace_id TEXT NOT NULL,
  emitted_by TEXT NOT NULL DEFAULT 'supervisor',
  created_at TEXT NOT NULL,
  CHECK (confidence_lo <= confidence_hi)
);

-- Evidence events emitted by specialist agents during a run.
-- Powers GET /api/hv/hypotheses/:id/events SSE stream.
CREATE TABLE IF NOT EXISTS hv_evidence_event (
  id TEXT PRIMARY KEY,                           -- UUID
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,                         -- workflow step that emitted this (e.g. 'statistical')
  agent_id TEXT NOT NULL,                        -- agent name
  evidence_id TEXT NOT NULL,                     -- contract evidence item id
  kind TEXT NOT NULL,                            -- e.g. 'stat_finding', 'lit_hit', 'sim_result'
  summary TEXT NOT NULL,
  source_type TEXT NOT NULL,                     -- 'sandbox_tool_run' | 'http_fetch' | 'model_inference'
  tool_key TEXT,                                 -- tool that produced this (nullable for model inferences)
  reproducibility_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_evidence_event_hypothesis ON hv_evidence_event(hypothesis_id, created_at ASC);

-- Agent-to-agent dialogue turns during the deliberation loop.
-- Powers GET /api/hv/hypotheses/:id/dialogue SSE stream.
CREATE TABLE IF NOT EXISTS hv_agent_turn (
  id TEXT PRIMARY KEY,                           -- UUID
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  round_index INTEGER NOT NULL DEFAULT 0,
  from_agent TEXT NOT NULL,
  to_agent TEXT,                                 -- null = broadcast
  message TEXT NOT NULL,
  cites_evidence_ids TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  dissent INTEGER NOT NULL DEFAULT 0,            -- boolean (0 | 1)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_agent_turn_hypothesis ON hv_agent_turn(hypothesis_id, created_at ASC);

-- Backward-compatible read-only aliases for legacy SV names.
CREATE VIEW IF NOT EXISTS sv_budget_envelope AS SELECT * FROM hv_budget_envelope;
CREATE VIEW IF NOT EXISTS sv_hypothesis AS SELECT * FROM hv_hypothesis;
CREATE VIEW IF NOT EXISTS sv_sub_claim AS SELECT * FROM hv_sub_claim;
CREATE VIEW IF NOT EXISTS sv_verdict AS SELECT * FROM hv_verdict;
CREATE VIEW IF NOT EXISTS sv_evidence_event AS SELECT * FROM hv_evidence_event;
CREATE VIEW IF NOT EXISTS sv_agent_turn AS SELECT * FROM hv_agent_turn;
`;
