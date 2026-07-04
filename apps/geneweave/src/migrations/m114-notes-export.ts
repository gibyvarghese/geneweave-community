import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m114 — weaveNotes Phase 10: sharing/export/polish — note EXPORT.
 *
 * Sharing (co-edit links + publish-as-public-artifact with redaction) and version history already
 * shipped in earlier phases; the gap this fills is a first-class **export/download** of a note in the
 * format a person actually wants. Governed by two Builder-editable settings (defaults match the package
 * `DEFAULT_WEAVENOTES_CONFIG`):
 *   - `export_enabled`          — allow exporting/downloading a note (default on),
 *   - `allowed_export_formats`  — which formats are offered (JSON array of markdown/html/word/json).
 *
 * Registers the **`export_note`** tool — so the assistant can "export my note as markdown" — grants it
 * to the weaveNotes Editor agent, and enables it. The export itself reuses `@weaveintel/collab`'s
 * serializers. Idempotent (safeExec ALTERs + INSERT OR IGNORE + JSON merges).
 */
export function applyM114NotesExport(db: BetterSqlite3.Database): void {
  // ── 1. Export capability settings ────────────────────────────────────────────
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN export_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN allowed_export_formats TEXT NOT NULL DEFAULT '["markdown","html","word","json"]'`);

  // ── 2. Register the export_note tool + grant it ──────────────────────────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'read-only', 0, 20000, 30, 1, ?, '1.0', 0, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000014', 'Export note',
      'Export one of the user’s notes in a chosen format so they can keep a copy, share it, or open it in another app. Use this when the user asks to "export", "download", or "save this note as" Markdown / a web page (HTML) / Word / a lossless JSON backup. You only need the note id and the format (markdown | html | word | json; default markdown). Returns the exported content for Markdown/HTML/JSON, or a download link.',
      'export_note',
      JSON.stringify(['notes', 'weavenotes', 'export']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'export_note'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'export_note'])]));
    }
  } catch { /* ignore */ }
}
