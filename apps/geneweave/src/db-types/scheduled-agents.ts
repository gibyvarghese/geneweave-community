// SPDX-License-Identifier: MIT
/** A per-user scheduled workspace agent (m129). Booleans are 0/1; next_run_at is epoch-ms. */
export interface ScheduledNoteAgentRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  name: string;
  recipe: string;
  task_prompt: string;
  trigger_type: string;
  cron: string;
  timezone: string;
  scope: string;
  scope_tag: string;
  lookback_days: number;
  max_notes: number;
  token_budget: number;
  max_steps: number;
  require_approval: number;
  enabled: number;
  last_run_id: string | null;
  last_run_at: string | null;
  next_run_at: number | null;
  created_at: string;
  updated_at: string | null;
}

/** One row of the scheduled-agent run audit log (m129). */
export interface ScheduledNoteAgentRunRow {
  id: string;
  agent_id: string;
  user_id: string;
  tenant_id: string | null;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  steps: number;
  tokens_used: number;
  notes_scanned: number;
  suggestions_created: number;
  output_note_id: string | null;
  summary: string | null;
  error: string | null;
  detail_json: string | null;
}
