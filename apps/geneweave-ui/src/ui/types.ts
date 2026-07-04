// Type definitions for the geneWeave UI

export interface User {
  id?: string;
  name?: string;
  email?: string;
}

export interface Chat {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  tokens_used?: number;
  cost?: number;
  latency_ms?: number;
  metadata?: string;
  attachments?: Attachment[];
  steps?: Step[];
  mode?: string;
  evalResult?: any;
  cognitive?: any;
  redaction?: any;
  guardrail?: any;
  activeSkills?: Skill[];
  enabledTools?: string[];
  skillTools?: string[];
  skillPromptApplied?: boolean;
  processState?: string;
  processExpanded?: boolean;
  processUi?: any;
  usage?: any;
  screenshots?: Screenshot[];
  ensembleCandidates?: Array<{ agentName: string; output: string }>;
  ensembleRationale?: string;
  ensembleWinner?: string;
}

export interface Attachment {
  name?: string;
  mimeType?: string;
  size?: number;
  dataBase64?: string;
  transcript?: string;
}

export interface Step {
  type?: string;
  kind?: string;
  text?: string;
  content?: string;
  name?: string;
  toolName?: string;
  worker?: string;
  input?: any;
  result?: any;
  toolCall?: any;
  delegation?: any;
  durationMs?: number;
}

export interface Skill {
  name?: string;
  id?: string;
  score?: number;
  category?: string;
  tools?: string[];
}

export interface Screenshot {
  base64: string;
  format?: string;
}

export interface ChartSpec {
  type: 'bar' | 'line';
  title: string;
  labels: string[];
  values: number[];
  unit?: string;
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface Model {
  id: string;
  provider: string;
  name?: string;
}

export interface ChatSettings {
  mode?: string;
  systemPrompt?: string;
  timezone?: string;
  enabledTools?: string[];
  redactionEnabled?: boolean;
  redactionPatterns?: string[];
  workers?: string[];
  // W1 — Reflection
  reflectEnabled?: boolean;
  reflectMaxRevisions?: number;
  reflectCriteria?: string;
  // W2 — Evaluator-Optimizer
  verifyEnabled?: boolean;
  verifyMinScore?: number;
  verifyMaxAttempts?: number;
  // W3 — Supervisor
  supervisorReplanOnFailure?: boolean;
  supervisorParallelDelegation?: boolean;
  // W5 — Ensemble
  ensembleAgents?: unknown[];
  ensembleResolver?: string;
}

// ── DB row types used by the Kaggle admin UI ─────────────────────────────────
// These are plain data shapes — no logic, no server imports. Kept here so the
// UI package has no dependency on the API package at runtime.

export type KglRunStatus = 'queued' | 'running' | 'completed' | 'abandoned' | 'failed';
export type KglRunStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface KglCompetitionRunRow {
  id: string;
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

export interface KglRunStepRow {
  id: string;
  run_id: string;
  step_index: number;
  role: string;
  title: string;
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
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  agent_id: string | null;
  tool_key: string | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export interface LiveMeshMessageView {
  id: string;
  meshId: string | null;
  fromType: string | null;
  fromId: string | null;
  toType: string | null;
  toId: string | null;
  topic: string | null;
  kind: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  processedAt: string | null;
}

export interface LiveMeshRow {
  id: string;
  tenant_id: string | null;
  mesh_def_id: string;
  name: string;
  status: string;
  domain: string | null;
  dual_control_required_for: string;
  owner_human_id: string | null;
  mcp_server_ref: string | null;
  account_id: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveAgentRow {
  id: string;
  mesh_id: string;
  agent_def_id: string | null;
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  attention_policy_key: string | null;
  contract_version_id: string | null;
  status: string;
  ordering: number;
  archived_at: string | null;
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
}
