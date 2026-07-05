import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m149 — Skill governance surface for the mid-2026 @weaveintel/skills 0.1.2 engine (follow-up to m148).
 *
 * Adds the persistence the remaining engine capabilities need, all additive/idempotent:
 *   • `mined_skill_proposals` — a review queue for skills the miner proposes from failing run traces.
 *     Proposals are ALWAYS created disabled + draft; the only way one becomes a live skill is an admin
 *     approving it (which runs it through the Phase-4 evaluation + promotion gate).
 *   • `user_mcp_tokens.service` — a discriminator so the existing per-user MCP token table can also back
 *     the read-only Skills MCP endpoint (`service='skills'`) alongside the notes one (`'notes'`).
 */
export function applyM149SkillGovernance(db: BetterSqlite3.Database): void {
  // Reuse the m130 MCP-token table for the Skills MCP endpoint too, distinguished by `service`.
  safeExec(db, `ALTER TABLE user_mcp_tokens ADD COLUMN service TEXT NOT NULL DEFAULT 'notes'`);

  // The mining review queue. Every proposal is disabled/draft until a human approves it.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mined_skill_proposals (
      id TEXT PRIMARY KEY,
      proposed_skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      tool_names TEXT NOT NULL DEFAULT '[]',
      pattern TEXT NOT NULL DEFAULT '',
      occurrences INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL DEFAULT '{}',
      safety TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mined_proposals_status ON mined_skill_proposals(status, created_at)`);
}
