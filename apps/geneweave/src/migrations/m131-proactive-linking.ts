import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m131 — weaveNotes Phase 3: proactive linking (suggest connections as you write).
 *
 * As you type, the editor can surface the notes you ALREADY referred to — either by name
 * (an "unlinked mention", where you typed another note's title as plain text) or by meaning
 * (a semantically-related note) — and offer to turn each into a one-click `[[wiki-link]]`.
 * Accepting a suggestion wraps just that phrase in a link (lossless) and the backlink appears
 * on the other note automatically. This builds the knowledge graph as a by-product of writing,
 * instead of asking people to remember to link things by hand.
 *
 *   - weavenotes_settings.proactive_linking_enabled — global Builder dial (default ON).
 *   - the `suggest_links` tool in tool_catalog (granted to the weaveNotes Editor agent) so the
 *     assistant can list/apply link suggestions from a normal chat too.
 * Idempotent.
 */
export function applyM131ProactiveLinking(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN proactive_linking_enabled INTEGER NOT NULL DEFAULT 1`);

  // Register the suggest_links tool + grant it to the weaveNotes Editor agent.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 30000, 30, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000019', 'Suggest links',
      'Find the notes a note already refers to but hasn’t linked — other notes mentioned by name plus semantically related ones — and optionally turn the first plain mention into a [[wiki-link]] (the backlink appears automatically). Use when the user asks to "link this up", "connect related notes", or "suggest links for this note".',
      'suggest_links',
      JSON.stringify(['notes', 'weavenotes', 'graph', 'links']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'suggest_links'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'suggest_links'])]));
    }
  } catch { /* ignore */ }
}
