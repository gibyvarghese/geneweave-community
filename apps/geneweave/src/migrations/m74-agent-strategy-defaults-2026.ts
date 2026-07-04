/**
 * Migration m74 — Agent Strategy Defaults 2026
 *
 * Phase 7 of the mid-2026 DB Content Audit:
 *
 *   1. ADD 4 new columns to `agent_strategy_settings`:
 *        hitl_threshold         REAL    DEFAULT 0.75  — risk threshold that triggers HITL approval
 *        max_agent_hops         INTEGER DEFAULT 5     — max A2A delegation chain depth (loop guard)
 *        tool_confirmation_level TEXT   DEFAULT 'high-risk-only' — 'none'|'medium'|'high-risk-only'
 *        memory_policy          TEXT    DEFAULT 'session'        — 'none'|'session'|'persistent'
 *
 *   2. UPDATE the global defaults row to 2026-appropriate values:
 *        a2a_enabled=1               (A2A spec v0.9+ is stable)
 *        supervisor_parallel_delegation=1  (parallel delegation is now the norm for speed)
 *        reflect_enabled=1           (reflection improves quality for complex tasks)
 *      Note: verify_enabled and supervisor_replan_on_failure stay at 0 — operators opt in.
 *
 *   3. INSERT 2 new mode_labels rows (idempotent INSERT OR IGNORE):
 *        surface='web',  mode_key='operator' — enterprise admin / operator surface
 *        surface='api',  mode_key='headless' — programmatic API / headless surface
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* column already exists — idempotent */ }
}

export function applyM74AgentStrategyDefaults2026(db: BetterSqlite3.Database): void {
  // ── 1. New columns on agent_strategy_settings ─────────────────────────────

  // Risk score in [0,1] at which HITL approval is required. Default 0.75 means
  // "require human approval for actions rated >= 75% risk by the safety scorer."
  safe(db, `ALTER TABLE agent_strategy_settings ADD COLUMN hitl_threshold REAL NOT NULL DEFAULT 0.75`);

  // Maximum number of A2A delegation hops before the chain is forcibly terminated.
  // Prevents infinite delegation loops in misconfigured multi-agent graphs.
  safe(db, `ALTER TABLE agent_strategy_settings ADD COLUMN max_agent_hops INTEGER NOT NULL DEFAULT 5`);

  // Three-tier tool confirmation gate: 'none' (auto-approve all tools),
  // 'medium' (confirm tools with data-write or external effects),
  // 'high-risk-only' (confirm only irreversible / destructive tools).
  safe(db, `ALTER TABLE agent_strategy_settings ADD COLUMN tool_confirmation_level TEXT NOT NULL DEFAULT 'high-risk-only'`);

  // Governs what the memory subsystem persists across sessions.
  // 'none' = no memory; 'session' = within-session only; 'persistent' = cross-session vector/graph memory.
  safe(db, `ALTER TABLE agent_strategy_settings ADD COLUMN memory_policy TEXT NOT NULL DEFAULT 'session'`);

  // ── 2. Flip global defaults to 2026-appropriate values ────────────────────
  //
  // Only the global row (id='global') is updated. Tenant-scoped rows, if any,
  // keep their existing values. Using a conditional UPDATE so this is safe to
  // run multiple times (the SET is idempotent for these boolean columns).
  safe(db, `
    UPDATE agent_strategy_settings
    SET
      a2a_enabled                   = 1,
      supervisor_parallel_delegation = 1,
      reflect_enabled               = 1,
      updated_at                    = datetime('now')
    WHERE id = 'global'
  `);

  // ── 3. New mode_labels rows ───────────────────────────────────────────────
  //
  // 'web/operator' — exposed to enterprise admin users via the web UI; higher
  //   privileges than the standard assistant/agent modes.
  // 'api/headless' — programmatic API access where no UI is rendered; used by
  //   automation pipelines and SDK consumers.
  const insertMode = db.prepare(`
    INSERT OR IGNORE INTO mode_labels (id, surface_id, mode_key, label, description, sort_order, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  insertMode.run(
    'm74-mode-web-operator',
    'web',
    'operator',
    'Operator',
    'Enterprise admin / operator surface — elevated permissions for managing agents, tools, and tenants.',
    90,
  );

  insertMode.run(
    'm74-mode-api-headless',
    'api',
    'headless',
    'Headless',
    'Programmatic API / headless surface — no UI rendering; used by SDK clients and automation pipelines.',
    10,
  );
}
