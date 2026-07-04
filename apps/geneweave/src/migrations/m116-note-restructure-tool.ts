import type BetterSqlite3 from 'better-sqlite3';

/**
 * m116 — weaveNotes: the whole-note restructure tool.
 *
 * Until now the AI could ADD to a note (note_edit) or draw in it (create_diagram / draw_ink), but
 * it could not REORGANISE one — reorder and group its sections, fix an inconsistent heading
 * hierarchy, or rearrange the existing content to a desired outline. `restructure_note` does
 * exactly that, keeping every fact and staging the reorganised note as ONE track-changes
 * suggestion the human accepts or rejects (the AI never silently rewrites a note's structure).
 *
 * Like every other note tool this is a first-class, Builder-governable capability:
 *   - registers `restructure_note` in `tool_catalog` (Builder-visible);
 *   - grants it to the seeded **weaveNotes Editor** worker agent (adds it to its tool_names);
 *   - merges it into `weavenotes_settings.enabled_ai_tools`.
 * Idempotent (INSERT OR IGNORE + JSON merges).
 */
export function applyM116NoteRestructureTool(db: BetterSqlite3.Database): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000015',
      'Restructure note',
      'Reorganise the WHOLE of one of the user’s notes — reorder and group its sections, fix the heading hierarchy, and tidy the structure — while keeping every fact. The result is staged as a single track-changes suggestion the user accepts or rejects. Optionally follows a desired outline the user provides.',
      'restructure_note',
      JSON.stringify(['notes', 'weavenotes', 'structure']),
    );
  } catch { /* ignore */ }

  // Grant the tool to the weaveNotes Editor agent.
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      const merged = [...new Set([...names, 'restructure_note'])];
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }

  // Enable it in the weaveNotes settings (merge, don't clobber).
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      const merged = [...new Set([...tools, 'restructure_note'])];
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }
}
