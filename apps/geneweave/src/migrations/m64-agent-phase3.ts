/**
 * Migration m64 — Agent Phase 3: HITL interrupts & agent handoff
 *
 * New tables:
 *   hitl_interrupt_requests — persistent audit log of every interrupt raised
 *     by an agent loop (tool approval requests, policy threshold alerts, etc.)
 *     The status column mirrors HumanTask.status so geneWeave can poll it.
 *
 *   agent_handoff_log — immutable record of every lateral agent transfer.
 *     Joins to chats/messages for full conversation provenance.
 *
 * New columns on chat_settings:
 *   hitl_enabled        — master toggle: when 1, the chat engine wires
 *                         an onInterrupt handler into every weaveAgent call
 *   hitl_require_all    — when 1, ALL tool calls require approval (not just
 *                         requireApproval-tagged tools)
 *   hitl_timeout_ms     — how long to wait for a human decision before
 *                         auto-rejecting the tool call
 *   handoffs_enabled    — master toggle for lateral agent handoff
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM64AgentPhase3(db: BetterSqlite3.Database): void {
  // ── chat_settings: HITL + handoff feature toggles ────────────────────────

  safe(db, 'ALTER TABLE chat_settings ADD COLUMN hitl_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN hitl_require_all INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN hitl_timeout_ms INTEGER NOT NULL DEFAULT 300000');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN handoffs_enabled INTEGER NOT NULL DEFAULT 0');

  // ── hitl_interrupt_requests ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS hitl_interrupt_requests (
      -- Surrogate primary key (UUIDv7)
      id              TEXT PRIMARY KEY,
      -- Context
      chat_id         TEXT NOT NULL,
      message_id      TEXT,              -- set after message is created
      agent_name      TEXT NOT NULL,
      agent_step      INTEGER NOT NULL,
      -- Tool details
      tool_name       TEXT NOT NULL,
      tool_args_json  TEXT NOT NULL DEFAULT '{}',
      interrupt_type  TEXT NOT NULL DEFAULT 'tool_approval',
      reason          TEXT NOT NULL DEFAULT '',
      -- Decision lifecycle
      status          TEXT NOT NULL DEFAULT 'pending',
        -- pending | approved | rejected | modified | expired
      decision_action TEXT,              -- 'approve' | 'reject' | 'modify'
      modified_args_json TEXT,           -- for 'modify' action
      feedback        TEXT,              -- human feedback shown to LLM
      assignee        TEXT,
      decided_by      TEXT,
      decided_at      TEXT,
      expires_at      TEXT,              -- ISO 8601; NULL means no expiry
      -- Audit
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_hitl_chat_status ON hitl_interrupt_requests(chat_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_hitl_agent_pending ON hitl_interrupt_requests(agent_name, status) WHERE status = \'pending\'');
    db.exec('CREATE INDEX IF NOT EXISTS idx_hitl_created_at ON hitl_interrupt_requests(created_at DESC)');
  } catch { /* ok if index exists */ }

  // ── agent_handoff_log ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_handoff_log (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      -- Transfer metadata
      from_agent      TEXT NOT NULL,
      to_agent        TEXT NOT NULL,
      transfer_input  TEXT NOT NULL DEFAULT '',
      -- Result summary
      result_status   TEXT,              -- completed | failed | cancelled | ...
      result_output   TEXT,              -- first 4000 chars of the target agent output
      -- Timing
      started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at    TEXT,
      duration_ms     INTEGER,
      -- Audit
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_chat ON agent_handoff_log(chat_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_agents ON agent_handoff_log(from_agent, to_agent)');
  } catch { /* ok if index exists */ }
}
