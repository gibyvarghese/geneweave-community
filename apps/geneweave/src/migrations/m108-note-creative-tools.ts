import type BetterSqlite3 from 'better-sqlite3';

/**
 * m108 — weaveNotes Phase 4: the AI creative tools (ink + diagrams).
 *
 * Phase 4 lets the assistant CREATE visual content in a note — a colour-coded diagram, or real
 * editable freehand ink (an underline, an arrow, a circled word). This migration makes those
 * first-class, governable capabilities like every other:
 *
 *   - registers `create_diagram` / `draw_ink` / `recolor_ink` in `tool_catalog` (Builder-visible);
 *   - grants them to the seeded **weaveNotes Editor** worker agent (adds them to its tool_names);
 *   - merges them into `weavenotes_settings.enabled_ai_tools` so the editor agent may use them.
 *
 * Output is native + editable and arrives as a track-changes SUGGESTION the human accepts or
 * rejects — the AI never silently draws on your note. Idempotent (INSERT OR IGNORE + JSON merges).
 */
export function applyM108NoteCreativeTools(db: BetterSqlite3.Database): void {
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
       id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source, credential_id,
       config, allocation_class, created_at, updated_at
     ) VALUES (?, ?, ?, 'notes', ?, 0, 60000, 20, 1, ?, '1.0', ?, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
  );
  const TOOLS: Array<{ id: string; key: string; name: string; desc: string }> = [
    { id: 'note00000-0000-4000-8000-00000000000b', key: 'create_diagram', name: 'Create diagram', desc: 'Draw a native, editable, colour-coded diagram (flow / mind-map / graph) in one of the user’s notes — the AI designs the nodes + edges and picks intentional, WCAG-AA colours. Staged as a track-changes suggestion the user accepts or rejects.' },
    { id: 'note00000-0000-4000-8000-00000000000c', key: 'draw_ink', name: 'Draw ink', desc: 'Draw real, editable freehand ink (an underline, a line, an arrow, a box, a circle, a check) in one of the user’s notes — the same stroke data a human pen produces. Staged as a track-changes suggestion.' },
    { id: 'note00000-0000-4000-8000-00000000000d', key: 'recolor_ink', name: 'Recolour ink', desc: 'Recolour the freehand ink in one of the user’s notes (e.g. "make all my arrows green"). Staged as a track-changes suggestion the user accepts or rejects.' },
  ];
  for (const t of TOOLS) {
    try { insertTool.run(t.id, t.name, t.desc, 'external-side-effect', t.key, 1, JSON.stringify(['notes', 'weavenotes', 'creative'])); } catch { /* ignore */ }
  }

  // Grant the creative tools to the weaveNotes Editor agent.
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      const merged = [...new Set([...names, 'create_diagram', 'draw_ink', 'recolor_ink'])];
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }

  // Enable the creative tools in the weaveNotes settings (merge, don't clobber).
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      const merged = [...new Set([...tools, 'create_diagram', 'draw_ink', 'recolor_ink'])];
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }
}
