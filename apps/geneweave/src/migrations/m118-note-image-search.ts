import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m118 — weaveNotes: source a real, FREE-TO-USE image from the web ("find_image").
 *
 * A small text model can't draw accurate anatomy (a "heart" comes out a blob), so when a note asks
 * for a *picture* the better answer is to fetch a real, free-to-use image and insert it WITH
 * attribution. This migration makes that a first-class, governed capability:
 *
 *   - adds the image-search settings to weavenotes_settings (enabled / provider / allowed licences /
 *     require-attribution) — global, Builder-editable, like the other capability toggles;
 *   - seeds the per-tenant ROUTING row for `find_image` in note_action_modes (default `direct` — it's
 *     a fetch, not an LLM design, so direct is fast);
 *   - registers the `find_image` tool in tool_catalog, grants it to the weaveNotes Editor worker, and
 *     enables it in weavenotes_settings.enabled_ai_tools.
 *
 * The fetch (provider search + image download) runs through the HARDENED, SSRF-guarded fetch. Every
 * sourced image is inserted as a track-changes suggestion with a licence + attribution caption.
 * Idempotent (safeExec ALTERs + INSERT OR IGNORE + JSON merges).
 */
export function applyM118NoteImageSearch(db: BetterSqlite3.Database): void {
  // 1) weavenotes_settings columns (global capability config).
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_search_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_search_provider TEXT NOT NULL DEFAULT 'openverse'`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_search_allowed_licenses TEXT NOT NULL DEFAULT '["cc0","pdm","by","by-sa","unsplash","pexels","pixabay"]'`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_search_require_attribution INTEGER NOT NULL DEFAULT 1`);

  // 2) per-tenant routing row for find_image (default direct — it's a fetch, not an LLM design).
  try {
    db.prepare(
      `INSERT OR IGNORE INTO note_action_modes (id, tenant_id, action_key, mode, updated_at)
         VALUES ('noteact00-0000-4000-8000-000000000006', '', 'find_image', 'direct', datetime('now'))`,
    ).run();
  } catch { /* table may not exist on a very old DB; ignore */ }

  // 3) register the find_image tool in the catalog (Builder-governable).
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000016',
      'Find image',
      'Find a real, FREE-TO-USE image on the web (Openverse / Wikimedia / Unsplash / Pexels / Pixabay) and insert it into one of the user’s notes with its licence + attribution. Use this when the user asks to "show / add / insert / find a picture/photo/image of …", or to "draw" something that is better shown as a real picture (e.g. an anatomical organ) than as a boxes-and-arrows diagram. Staged as a track-changes suggestion. The fetch is SSRF-hardened and only public images under allowed licences are used.',
      'find_image',
      JSON.stringify(['notes', 'weavenotes', 'image', 'web']),
    );
  } catch { /* ignore */ }

  // 4) grant find_image to the weaveNotes Editor agent.
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'find_image'])]));
    }
  } catch { /* ignore */ }

  // 5) enable find_image in the weaveNotes settings (merge, don't clobber).
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'find_image'])]));
    }
  } catch { /* ignore */ }
}
