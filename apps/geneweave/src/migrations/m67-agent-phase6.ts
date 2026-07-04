/**
 * Migration m67 — Agent Phase 6: Evaluation Pipeline, Cost Governor, Compliance, Vision Loop
 *
 * New columns on chat_settings:
 *   eval_pipeline_enabled       — enable multi-tier eval pipeline on this chat
 *   eval_pipeline_stages        — JSON array of EvalStageConfig objects
 *   eval_pipeline_fail_fast     — short-circuit on first rejection (default 1)
 *   cost_governor_enabled       — enable cost-governor bundle (compaction + budget gate)
 *   cost_governor_policy        — JSON CostGovernorPolicy object
 *   compliance_enabled          — enable consent-check at tool call time
 *   compliance_subject_id_field — field in ctx.user to use as GDPR subject ID
 *   compliance_enforce_consent  — block tool calls when consent is denied (default 1)
 *   vision_loop_enabled         — detect screenshot tool outputs and inject as ImageContent
 *
 * New tables:
 *   agent_eval_pipeline_runs    — audit log of eval pipeline results per agent run
 *   agent_cost_ledger           — cost ledger entries for cost-governor runs
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM67AgentPhase6(db: BetterSqlite3.Database): void {
  // ── chat_settings: P6 feature toggles ───────────────────────────────────

  // P6-1: Eval pipeline
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN eval_pipeline_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN eval_pipeline_stages TEXT');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN eval_pipeline_fail_fast INTEGER NOT NULL DEFAULT 1');

  // P6-3: Cost governor
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN cost_governor_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN cost_governor_policy TEXT');

  // P6-4: Compliance
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN compliance_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN compliance_subject_id_field TEXT');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN compliance_enforce_consent INTEGER NOT NULL DEFAULT 1');

  // P6-5: Vision loop
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN vision_loop_enabled INTEGER NOT NULL DEFAULT 0');

  // ── agent_eval_pipeline_runs ─────────────────────────────────────────────
  // Audit log: one row per agent run that had evalPipeline active.
  // Stores the full EvalPipelineReport JSON so callers can inspect which
  // stages passed/failed and at what score.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_eval_pipeline_runs (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      run_id          TEXT NOT NULL,
      agent_name      TEXT NOT NULL,
      -- EvalPipelineReport as JSON
      report          TEXT NOT NULL,
      accepted        INTEGER NOT NULL DEFAULT 1,
      overall_score   REAL NOT NULL DEFAULT 1.0,
      revisions       INTEGER NOT NULL DEFAULT 0,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      evaluated_at    TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_eval_pipeline_chat ON agent_eval_pipeline_runs(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_eval_pipeline_run ON agent_eval_pipeline_runs(run_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_eval_pipeline_accepted ON agent_eval_pipeline_runs(chat_id, accepted)');
  } catch { /* ok if already exists */ }

  // ── agent_cost_ledger ────────────────────────────────────────────────────
  // Persistent cost ledger: one row per model call when cost-governor is active.
  // Mirrors the CostLedgerEntry shape from @weaveintel/cost-governor.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_cost_ledger (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      run_id          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      -- Token counts
      prompt_tokens   INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      -- Cost in USD (may be null when pricing resolver returns null)
      cost_usd        REAL,
      -- ISO timestamp of the model call
      called_at       TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_ledger_chat ON agent_cost_ledger(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON agent_cost_ledger(run_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_ledger_agent ON agent_cost_ledger(agent_id)');
  } catch { /* ok if already exists */ }

  // ── agent_compliance_audit ───────────────────────────────────────────────
  // Compliance audit log: one row per tool call when compliance check ran.
  // Stores GDPR/SOC2-tagged events with outcome and data classification.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_compliance_audit (
      id                  TEXT PRIMARY KEY,
      chat_id             TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      run_id              TEXT NOT NULL,
      agent_name          TEXT NOT NULL,
      tool_name           TEXT NOT NULL,
      subject_id          TEXT,
      purpose             TEXT,
      data_classification TEXT,
      outcome             TEXT NOT NULL,
      denied_reason       TEXT,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_compliance_chat ON agent_compliance_audit(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_compliance_subject ON agent_compliance_audit(subject_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_compliance_tool ON agent_compliance_audit(tool_name, outcome)');
  } catch { /* ok if already exists */ }
}
