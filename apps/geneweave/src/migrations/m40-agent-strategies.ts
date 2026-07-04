/**
 * Migration m40 — Agent Reasoning Strategies
 *
 * Adds strategy configuration columns to `chat_settings` and a new
 * `agent_strategy_settings` table for global/tenant-level defaults.
 *
 * W1 (reflection), W2 (verify), W3 (supervisor re-plan + parallel),
 * W5 (ensemble mode) — all configurable as DB-driven settings, no redeploy.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM40AgentStrategies(db: BetterSqlite3.Database): void {
  // ── chat_settings: W1 — Reflection ─────────────────────────────────────────
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN reflect_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN reflect_max_revisions INTEGER NOT NULL DEFAULT 1');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN reflect_criteria TEXT');

  // ── chat_settings: W2 — Verify/regenerate ─────────────────────────────────
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN verify_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN verify_min_score REAL NOT NULL DEFAULT 0.7');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN verify_max_attempts INTEGER NOT NULL DEFAULT 1');

  // ── chat_settings: W3 — Supervisor re-plan + parallel ─────────────────────
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN supervisor_replan_on_failure INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN supervisor_parallel_delegation INTEGER NOT NULL DEFAULT 0');

  // ── chat_settings: W5 — Ensemble mode ─────────────────────────────────────
  // ensemble_agents: JSON array of agent config objects (name, model, systemPrompt)
  // ensemble_resolver: 'vote' | 'judge' | 'arbiter' (null = vote)
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN ensemble_agents TEXT');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN ensemble_resolver TEXT');

  // ── agent_strategy_settings: global/tenant defaults ──────────────────────
  // Scope: 'global' (one row) or 'tenant' (one row per tenant_id).
  // Chat-level settings in chat_settings take precedence over these defaults.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_strategy_settings (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'global',
        tenant_id TEXT,
        reflect_enabled INTEGER NOT NULL DEFAULT 0,
        reflect_max_revisions INTEGER NOT NULL DEFAULT 1,
        reflect_criteria TEXT,
        verify_enabled INTEGER NOT NULL DEFAULT 0,
        verify_min_score REAL NOT NULL DEFAULT 0.7,
        verify_max_attempts INTEGER NOT NULL DEFAULT 1,
        supervisor_replan_on_failure INTEGER NOT NULL DEFAULT 0,
        supervisor_parallel_delegation INTEGER NOT NULL DEFAULT 0,
        ensemble_resolver TEXT,
        a2a_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* table may already exist */ }

  // Seed the single global defaults row.
  try {
    db.prepare(`
      INSERT OR IGNORE INTO agent_strategy_settings
        (id, scope, reflect_enabled, verify_enabled, supervisor_replan_on_failure, supervisor_parallel_delegation, a2a_enabled)
      VALUES ('global', 'global', 0, 0, 0, 0, 0)
    `).run();
  } catch { /* ignore */ }
}
