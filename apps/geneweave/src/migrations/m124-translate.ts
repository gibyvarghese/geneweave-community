import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m124 — weaveNotes Phase 2: first-class "translate this note" action.
 *
 * Adds one Builder-editable dial: whether the AI may translate a note into another language. A
 * translation is saved as a NEW note ("<title> (<Language>)") so the original is never touched, and
 * the translator preserves code/links/structure and verifies the result before saving. Idempotent.
 */
export function applyM124Translate(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 1');

  // Register the translate_note tool in the catalog, grant it to the weaveNotes Editor agent,
  // and add it to the enabled-tools allowlist (mirrors m110's make_flashcards wiring).
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000017', 'Translate note',
      'Translate one of the user’s notes into another language and save it as a NEW note (the original is left untouched). Preserves code, links and Markdown structure, and verifies the result before saving. You need the note id and the target language.',
      'translate_note',
      JSON.stringify(['notes', 'weavenotes', 'translate']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'translate_note'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'translate_note'])]));
    }
  } catch { /* ignore */ }
}
