/**
 * Migration m66 — Agent Phase 5: Checkpoint / Resume & Dynamic Workers
 *
 * New columns on chat_settings:
 *   checkpoint_enabled         — persist agent checkpoints for this chat
 *   checkpoint_interval_steps  — save a checkpoint every N tool-call steps
 *   dynamic_workers_enabled    — enable runtime worker registration via WorkerRegistry
 *   max_dynamic_workers        — hard cap on concurrently registered workers
 *
 * New table:
 *   agent_checkpoints  — persistent agent run checkpoints keyed by (chat_id, run_id)
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM66AgentPhase5(db: BetterSqlite3.Database): void {
  // ── chat_settings: checkpoint + dynamic-worker toggles ──────────────────

  safe(db, 'ALTER TABLE chat_settings ADD COLUMN checkpoint_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN checkpoint_interval_steps INTEGER NOT NULL DEFAULT 1');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN dynamic_workers_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN max_dynamic_workers INTEGER NOT NULL DEFAULT 20');

  // ── agent_checkpoints ────────────────────────────────────────────────────
  // Stores one row per (chat_id, run_id) combination. A run may have many
  // intermediate snapshots — only the latest payload for each run_id is kept
  // (upsert on run_id).
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      -- Surrogate key = run_id (caller-generated or auto-generated UUID)
      run_id          TEXT PRIMARY KEY,
      -- Scope — chat + user for ACL enforcement
      chat_id         TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      -- Checkpoint metadata
      agent_name      TEXT NOT NULL,
      step_index      INTEGER NOT NULL DEFAULT 0,
      -- Full checkpoint payload (serialised AgentCheckpoint JSON)
      payload         TEXT NOT NULL,
      -- Status of the run at the time of the last save (NULL if still in-progress)
      status          TEXT,
      -- Timestamps
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkpoints_chat ON agent_checkpoints(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkpoints_user ON agent_checkpoints(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON agent_checkpoints(agent_name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON agent_checkpoints(chat_id, status)');
  } catch { /* ok if index already exists */ }

  // Seed catalog entries for the new P5 checkpoint tools (informational only —
  // no built-in tools are registered; checkpoint is entirely transparent).
  const hasToolCatalog = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='tool_catalog'`,
  ).get() as { name?: string } | undefined)?.name === 'tool_catalog';

  if (hasToolCatalog) {
    const insertTool = db.prepare(`
      INSERT OR IGNORE INTO tool_catalog
        (id, name, description, source, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 'builtin', 1,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    insertTool.run(
      'checkpoint_list_runs',
      'checkpoint_list_runs',
      'List recent agent checkpoint run IDs for the current chat.',
    );
    insertTool.run(
      'checkpoint_load_run',
      'checkpoint_load_run',
      'Load and resume an agent from a previously saved checkpoint run ID.',
    );
  }
}
