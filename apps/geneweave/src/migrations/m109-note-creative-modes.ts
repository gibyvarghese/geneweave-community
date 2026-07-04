import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m109 — weaveNotes Phase 4 (creative expansion): per-workspace creative modes.
 *
 * The assistant can now make many kinds of visuals — node/edge DIAGRAMS (flow / mind-map /
 * process / block), freeform INK, AI-authored SVG ILLUSTRATIONS (vector art), and LLM-generated
 * raster IMAGES. Each is configuration-as-data, tuned in the Builder's weaveNotes Settings, so an
 * admin can enable/disable a mode (e.g. turn OFF raster image generation, which costs money) and
 * choose the image model. This migration adds those flags to `weavenotes_settings`:
 *
 *   - `diagrams_enabled`          (default ON)
 *   - `ink_enabled`               (default ON)
 *   - `illustration_enabled`      (default ON — vector SVG, no extra cost)
 *   - `image_generation_enabled`  (default OFF — raster images cost money + need an image model)
 *   - `image_model`               (default 'gpt-image-1')
 *
 * It also registers the new creative tools (create_illustration / generate_image / create_visual)
 * in `tool_catalog`, grants them to the weaveNotes Editor agent, and merges them into
 * `enabled_ai_tools`. Idempotent (safeExec ALTERs + INSERT OR IGNORE + JSON merges).
 */
export function applyM109NoteCreativeModes(db: BetterSqlite3.Database): void {
  // ── 1. Creative-mode flags on weavenotes_settings ────────────────────────────
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN diagrams_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN ink_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN illustration_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_generation_enabled INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN image_model TEXT NOT NULL DEFAULT 'gpt-image-1'`);

  // ── 2. Register the new creative tools in the tool catalog ───────────────────
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
       id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source, credential_id,
       config, allocation_class, created_at, updated_at
     ) VALUES (?, ?, ?, 'notes', ?, 0, 120000, 12, 1, ?, '1.0', ?, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
  );
  const TOOLS: Array<{ id: string; key: string; name: string; desc: string }> = [
    { id: 'note00000-0000-4000-8000-00000000000e', key: 'create_illustration', name: 'Create illustration', desc: 'Draw a detailed VECTOR illustration (an SVG — a heart, a leaf, a logo, a diagram figure) in one of the user’s notes. The AI authors the SVG; it is sanitised + embedded as an inert image. Staged as a track-changes suggestion. Best for a real picture the boxes-and-arrows diagram tool can’t express.' },
    { id: 'note00000-0000-4000-8000-00000000000f', key: 'generate_image', name: 'Generate image', desc: 'Generate a realistic RASTER image with an image model (e.g. gpt-image) and embed it in one of the user’s notes. Off by default (it costs money) — an admin enables it in weaveNotes Settings. Staged as a track-changes suggestion.' },
    { id: 'note00000-0000-4000-8000-000000000010', key: 'create_visual', name: 'Create visual (auto)', desc: 'The one-stop visual tool: describe ANY picture (a process diagram, a business chart, freeform ink, a vector illustration, or a realistic image) and the AI picks the best kind automatically (or pass kind = diagram|ink|illustration|image). Honours the workspace’s enabled modes. Staged as a track-changes suggestion.' },
  ];
  for (const t of TOOLS) {
    try { insertTool.run(t.id, t.name, t.desc, 'external-side-effect', t.key, 1, JSON.stringify(['notes', 'weavenotes', 'creative'])); } catch { /* ignore */ }
  }

  // ── 3. Grant to the weaveNotes Editor agent + enable in settings ─────────────
  const NEW = ['create_illustration', 'generate_image', 'create_visual'];
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, ...NEW])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, ...NEW])]));
    }
  } catch { /* ignore */ }
}
