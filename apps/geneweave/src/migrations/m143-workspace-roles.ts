import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m143 — Workspace roles: RBAC surface parity + role-aware access (Round 6).
 *
 * geneWeave is single-workspace-per-user (users.tenant_id + users.persona; no membership table — a tenant
 * SWITCHER would need that, so it's deferred). This round makes ROLES matter in the UI:
 *
 *  • The client now HIDES admin controls (Builder / Admin) from non-admins instead of showing them and
 *    letting the server 403 — driven by @weaveintel/identity canAccessArea (permission-based).
 *
 *  • tenant_role_access — a per-tenant policy for the OPTIONAL, member-visible areas: an admin can decide
 *    whether standard members (tenant_user) see the Dashboard, the Connectors area, and the Design studio.
 *    (Builder/Admin are always admin-only by permission; chat/notes/calendar are always visible.)
 *
 *  • list_workspace_members tool → a new weave_workspace worker agent + the general assistant, so the
 *    assistant can answer "who's on my team?" / "who are the admins here?" from the REAL members list
 *    (tenant-scoped, read-only; emails are only included for admins).
 *
 * Idempotent.
 */
export function applyM143WorkspaceRoles(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_role_access (
      tenant_id          TEXT PRIMARY KEY,
      member_dashboard   INTEGER NOT NULL DEFAULT 1,   -- can a standard member see the Dashboard?
      member_connectors  INTEGER NOT NULL DEFAULT 0,   -- ...the Connectors area? (off by default)
      member_design      INTEGER NOT NULL DEFAULT 1,   -- ...the Design studio?
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // list_workspace_members tool — read-only, tenant-scoped view of the team for the assistant.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'workspace', 'safe', 0, 20000, 20, 1, ?, '1.0', 0, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000029', 'List workspace members',
      'List the people in the user\'s workspace and the role each holds (Admin / Member / etc.), so you can answer "who is on my team?", "who are the admins here?", or "how many people are in this workspace?". Read-only and privacy-aware: it returns names + roles for everyone, and email addresses only when the person asking is an admin. It only ever sees the caller\'s own workspace.',
      'list_workspace_members',
      JSON.stringify(['workspace', 'team', 'roles', 'members']),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_workspace', 'Workspace guide', 'workspace', ?, ?, ?, 'assistant', ?, NULL, 1, 30, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000030',
      'Answers questions about who is in the user’s workspace and the roles they hold.',
      'You help the user understand their workspace team. Use list_workspace_members to see who is in the workspace and their roles, then answer plainly (e.g. who the admins are, how many members there are). Respect privacy: only share email addresses if the tool returned them (it does so only for admins). Never invent members.',
      JSON.stringify(['list_workspace_members']),
      JSON.stringify(['who is on my team', 'workspace members', 'who are the admins', 'how many people', 'my teammates']),
    );
  } catch { /* ignore */ }

  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'list_workspace_members'])]), agentName);
      }
    } catch { /* ignore */ }
  }
}
