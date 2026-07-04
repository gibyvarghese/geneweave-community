import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m136 — geneWeave UI rebuild: the Account settings surface (per-USER profile, preferences & notifications).
 *
 * The Account screen (design: "GeneWeave Account.dc.html") lets a person control how they appear across
 * geneWeave and what reaches them. Everything here is per-user and self-serve (distinct from the per-tenant
 * Appearance/branding in m135, which is admin-only). Three stores:
 *
 *   • user_preferences gains profile + preference columns (display name, pronouns, role, working hours,
 *     an "about" blurb, a status line, and formatting defaults: interface language, timezone, date format,
 *     start-of-week, and the Pro/Creative editor variant). We extend the existing table (idempotent ALTERs)
 *     rather than add a parallel one, so a user has a single settings row.
 *   • user_notification_prefs — the notifications matrix: for each event (mentions, shares, comments,
 *     "assistant finished", weekly digest) which of the three channels (in-app / email / push) are on.
 *   • the update_account_profile tool in tool_catalog, granted to a new weave_account worker agent (and to
 *     the weaveNotes Editor), so the assistant can help ("set my status to focusing", "turn off email for
 *     comments", "call me they/them") — always scoped to the signed-in user, never another person's account.
 *
 * Idempotent.
 */

/** The five notification events shown in the Account → Notifications matrix, with sensible channel defaults. */
export const NOTIFICATION_EVENTS: Array<{ key: string; in_app: number; email: number; push: number }> = [
  { key: 'mentions', in_app: 1, email: 1, push: 1 },
  { key: 'shares', in_app: 1, email: 1, push: 0 },
  { key: 'comments', in_app: 1, email: 1, push: 0 },
  { key: 'assistant_finished', in_app: 1, email: 0, push: 0 },
  { key: 'weekly_digest', in_app: 0, email: 1, push: 0 },
];

export function applyM136AccountProfile(db: BetterSqlite3.Database): void {
  // ── Extend user_preferences with profile + formatting-preference columns ────────────────────────────
  // Each ALTER is wrapped by safeExec so re-running the migration is a no-op once the column exists.
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN display_name TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN pronouns TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN role_title TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN working_hours TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN about TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN status_text TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN status_emoji TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN language TEXT NOT NULL DEFAULT 'en-US'");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN timezone TEXT");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN date_format TEXT NOT NULL DEFAULT 'D MMM YYYY'");
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN week_start TEXT NOT NULL DEFAULT 'monday'");
  // The Pro vs Creative editor variant is a per-user default (the per-tenant default lives in tenant_appearance).
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN ui_variant TEXT NOT NULL DEFAULT 'pro'");

  // ── Per-event notification channel matrix ───────────────────────────────────────────────────────────
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      in_app INTEGER NOT NULL DEFAULT 1,
      email INTEGER NOT NULL DEFAULT 0,
      push INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, event_key)
    )
  `);

  // ── The update_account_profile tool + a dedicated worker agent ──────────────────────────────────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'account', 'external-side-effect', 0, 30000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000023', 'Update account profile',
      'Update the signed-in person’s own account: their display name, pronouns, role/title, working hours, a short "about" blurb, their status line (e.g. "Focusing · back at 2:00"), formatting preferences (interface language, timezone, date format, start of week, Pro/Creative editor look), or which notifications reach them and where (in-app / email / push). Use when the user says things like "set my status to focusing", "call me they/them", "turn off email for comments", or "start my week on Sunday". Only ever changes the current user’s own account — never anyone else’s.',
      'update_account_profile',
      JSON.stringify(['account', 'profile', 'preferences', 'notifications']),
    );
  } catch { /* ignore */ }

  // Create a small dedicated worker agent for account self-service (mirrors how other capabilities register
  // a worker agent), and grant it the tool. Also grant the tool to the weaveNotes Editor so the in-note
  // assistant can help with account tweaks.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_account', 'Account assistant', 'account', ?, ?, ?, 'assistant', ?, NULL, 1, 40, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000024',
      'Helps a person manage their own geneWeave account — profile, preferences, and notifications — in plain language.',
      'You help the signed-in person manage their own account settings only: profile (name, pronouns, role, working hours, about, status), preferences (language, timezone, date format, start of week, Pro/Creative look), and notifications. Confirm changes plainly. Never touch another user’s account or workspace-wide settings.',
      JSON.stringify(['update_account_profile']),
      JSON.stringify(['set my status', 'change my name', 'my pronouns', 'my notifications', 'my timezone', 'start of week']),
    );
  } catch { /* ignore */ }
  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'update_account_profile'])]), agentName);
      }
    } catch { /* ignore */ }
  }

  // Seed the default notification matrix for any existing users who don't have rows yet, so the UI has
  // something meaningful on first open (users created later get defaults lazily by the service layer).
  try {
    const users = db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>;
    const ins = db.prepare(
      `INSERT OR IGNORE INTO user_notification_prefs (user_id, event_key, in_app, email, push) VALUES (?, ?, ?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (const u of users) for (const e of NOTIFICATION_EVENTS) ins.run(u.id, e.key, e.in_app, e.email, e.push);
    });
    seed();
  } catch { /* ignore */ }
}
