import type BetterSqlite3 from 'better-sqlite3';

/**
 * m106 — weaveNotes Phase 2: the AI selection card's colour tools.
 *
 * Phase 2 adds three colour tools the assistant can wield from the selection card (or from
 * chat): highlight a phrase, colour a phrase's text, and "colour-code by meaning"
 * (topic/importance/status/sentiment). This migration makes them first-class, governable
 * capabilities like every other:
 *
 *   - registers `apply_highlight` / `apply_text_color` / `colorize_semantic` in `tool_catalog`
 *     (so they show up in the Builder's Tool Catalog and can be enabled/disabled per policy);
 *   - grants them to the seeded **weaveNotes Editor** worker agent (adds them to its tool_names);
 *   - adds them to the `weavenotes_settings.enabled_ai_tools` list so the editor agent may use
 *     them out of the box (idempotently merges into whatever an admin already configured).
 *
 * Every change comes through the safe track-changes flow: a colour tool stages a SUGGESTION the
 * human accepts or rejects — the AI never silently repaints a note. Idempotent (INSERT OR IGNORE
 * + JSON merges), so a re-run is a no-op.
 */
export function applyM106NoteColorTools(db: BetterSqlite3.Database): void {
  // ── 1. Register the colour tools in the tool catalog ─────────────────────────
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
       id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source, credential_id,
       config, allocation_class, created_at, updated_at
     ) VALUES (?, ?, ?, 'notes', ?, 0, 60000, 30, 1, ?, '1.0', ?, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
  );
  const COLOR_TOOLS: Array<{ id: string; key: string; name: string; desc: string }> = [
    { id: 'note00000-0000-4000-8000-000000000008', key: 'apply_highlight', name: 'Apply highlight', desc: 'Highlight a phrase in one of the user’s notes with a colour swatch — staged as a track-changes suggestion the user accepts or rejects.' },
    { id: 'note00000-0000-4000-8000-000000000009', key: 'apply_text_color', name: 'Apply text colour', desc: 'Colour the text of a phrase in one of the user’s notes — staged as a track-changes suggestion the user accepts or rejects.' },
    { id: 'note00000-0000-4000-8000-00000000000a', key: 'colorize_semantic', name: 'Colour-code by meaning', desc: 'Colour-code a note BY MEANING (topic / importance / status / sentiment) — the AI picks the spans and a pre-validated WCAG-AA colour for each, staged as one suggestion to accept or reject.' },
  ];
  for (const t of COLOR_TOOLS) {
    try { insertTool.run(t.id, t.name, t.desc, 'external-side-effect', t.key, 1, JSON.stringify(['notes', 'weavenotes', 'colour'])); } catch { /* ignore */ }
  }

  // ── 2. Grant the colour tools to the weaveNotes Editor agent ──────────────────
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      const merged = [...new Set([...names, 'apply_highlight', 'apply_text_color', 'colorize_semantic'])];
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }

  // ── 3. Enable the colour tools in the weaveNotes settings (merge, don't clobber) ─
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      const merged = [...new Set([...tools, 'apply_highlight', 'apply_text_color', 'colorize_semantic'])];
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify(merged));
    }
  } catch { /* ignore */ }
}
