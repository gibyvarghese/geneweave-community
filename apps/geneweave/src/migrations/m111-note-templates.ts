import type BetterSqlite3 from 'better-sqlite3';
import { SYSTEM_TEMPLATES } from '../notes/templates.js';
import { safeExec } from './helpers.js';

/**
 * m111 — weaveNotes Phase 6: system templates + organisation (archive/trash).
 *
 * A new note shouldn't start blank. This migration:
 *   - SEEDS the system templates from `@weaveintel/notes` SYSTEM_TEMPLATES — one `notes` row per
 *     template (system-owned, `is_template=1`, `template_key`, the template's `doc_json`). They
 *     show up in the template gallery + "New from template", and the AI's `new_from_template`
 *     tool reads them. Deterministic ids → idempotent (INSERT OR IGNORE on re-run).
 *   - adds `notes.archived_at` so a note can be ARCHIVED/trashed (soft-delete) + RESTORED, instead
 *     of only hard-deleted. `listNotes` hides archived notes; an "Archived" view restores them.
 *   - registers the `new_from_template` tool in `tool_catalog`, grants it to the weaveNotes Editor
 *     agent, and enables it.
 *
 * Idempotent (safeExec ALTER + INSERT OR IGNORE + JSON merges).
 */
export function applyM111NoteTemplates(db: BetterSqlite3.Database): void {
  // ── 1. Archive/trash column ──────────────────────────────────────────────────
  safeExec(db, `ALTER TABLE notes ADD COLUMN archived_at TEXT`); // NULL = active; a timestamp = archived

  // ── 2. Seed the system templates ─────────────────────────────────────────────
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notes (id, owner_user_id, tenant_id, title, icon, parent_note_id, sensitivity, doc_json, is_template, template_key, favorite)
     VALUES (?, '_system', NULL, ?, ?, NULL, 'normal', ?, 1, ?, 0)`,
  );
  for (const tpl of SYSTEM_TEMPLATES) {
    try { insert.run(`note-tmpl-${tpl.key}`, tpl.title, tpl.icon, JSON.stringify(tpl.doc), tpl.key); } catch { /* ignore */ }
  }

  // ── 3. Register the new_from_template tool + grant it ─────────────────────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 30000, 30, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000012', 'New note from template',
      'Create a new note for the user from a ready-made TEMPLATE (e.g. meeting minutes, Cornell notes, a study sheet, a project brief, a daily planner). Use this when the user asks to "start a meeting minutes note", "make me a Cornell note", "new project brief", etc. Pass the template key and an optional title.',
      'new_from_template',
      JSON.stringify(['notes', 'weavenotes', 'templates']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'new_from_template'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'new_from_template'])]));
    }
  } catch { /* ignore */ }
}
