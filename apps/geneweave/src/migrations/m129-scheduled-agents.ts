import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m129 — weaveNotes Phase 3: SCHEDULED / TRIGGERED workspace agents.
 *
 * A user can set up a recurring AI task over their OWN notes ("every weekday 8am, digest yesterday's
 * notes"). It runs unattended INSIDE a budget (max tokens + max steps), produces an ADDITIVE output
 * note (never overwrites existing notes — the safe HITL posture), and EVERY run is logged for audit.
 *
 * Two tables:
 *   - scheduled_note_agents  — the per-user agent definitions (recipe, schedule, scope, budget).
 *   - scheduled_note_agent_runs — the run log: one row per run with status, tokens, steps, output.
 * Plus global Builder dials on weavenotes_settings, and the manage_scheduled_agent tool in the catalog
 * (granted to the weaveNotes Editor agent) so the assistant can set one up from a normal chat.
 * Idempotent.
 */
export function applyM129ScheduledAgents(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS scheduled_note_agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      name TEXT NOT NULL,
      recipe TEXT NOT NULL DEFAULT 'daily_digest',
      task_prompt TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT 'schedule',
      cron TEXT NOT NULL DEFAULT '0 8 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      scope TEXT NOT NULL DEFAULT 'recent',
      scope_tag TEXT NOT NULL DEFAULT '',
      lookback_days INTEGER NOT NULL DEFAULT 1,
      max_notes INTEGER NOT NULL DEFAULT 25,
      token_budget INTEGER NOT NULL DEFAULT 8000,
      max_steps INTEGER NOT NULL DEFAULT 8,
      require_approval INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_id TEXT,
      last_run_at TEXT,
      next_run_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_sched_agents_user ON scheduled_note_agents(user_id, enabled)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_sched_agents_due ON scheduled_note_agents(next_run_at) WHERE enabled = 1 AND trigger_type = 'schedule'`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS scheduled_note_agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      steps INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      notes_scanned INTEGER NOT NULL DEFAULT 0,
      suggestions_created INTEGER NOT NULL DEFAULT 0,
      output_note_id TEXT,
      summary TEXT,
      error TEXT,
      detail_json TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_sched_runs_agent ON scheduled_note_agent_runs(agent_id, started_at)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_sched_runs_user ON scheduled_note_agent_runs(user_id, started_at)`);

  // Global Builder dials.
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN scheduled_agents_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN scheduled_agent_max_token_budget INTEGER NOT NULL DEFAULT 20000`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN scheduled_agent_max_per_user INTEGER NOT NULL DEFAULT 10`);

  // Register the manage_scheduled_agent tool + grant it to the weaveNotes Editor agent.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000018', 'Manage scheduled agent',
      'Create, list, or run a SCHEDULED workspace agent — a recurring AI task over the user’s own notes (e.g. "every weekday 8am, digest yesterday’s notes"). Runs within a token/step budget and produces a new note. Use when the user asks to "set up a daily/weekly digest", "automatically summarise my notes", "schedule a task over my notes", or "run my scheduled agent now".',
      'manage_scheduled_agent',
      JSON.stringify(['notes', 'weavenotes', 'agent', 'schedule']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'manage_scheduled_agent'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'manage_scheduled_agent'])]));
    }
  } catch { /* ignore */ }
}
