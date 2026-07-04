import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m113 — weaveNotes Phase 8: desktop (Tauri shell — offline cache, open-to-last-note, quick capture).
 *
 * The desktop app wraps the web build and adds three governed capabilities (defaults match the package
 * `DEFAULT_WEAVENOTES_CONFIG`):
 *   - `desktop_offline_enabled`     — cache notes locally + reopen the last note offline (default on),
 *   - `quick_capture_enabled`       — the global quick-capture hotkey (default on),
 *   - `desktop_offline_note_limit`  — how many notes the desktop caches locally (default 500).
 *
 * It also registers the **`recent_notes`** tool — so the assistant can see what the user has recently
 * created or edited ("what was I working on?") — grants it to the weaveNotes Editor agent, and enables
 * it. Quick-capture itself reuses the existing create-note path (a desktop-stamped activity entry tells
 * the AI a note was captured on desktop). Idempotent (safeExec ALTERs + INSERT OR IGNORE + JSON merges).
 */
export function applyM113NotesDesktop(db: BetterSqlite3.Database): void {
  // ── 1. Desktop capability flags ──────────────────────────────────────────────
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN desktop_offline_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN quick_capture_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN desktop_offline_note_limit INTEGER NOT NULL DEFAULT 500`);

  // ── 2. Register the recent_notes tool + grant it ─────────────────────────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'read-only', 0, 15000, 60, 1, ?, '1.0', 0, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000013', 'Recent notes',
      'List the user’s most recently created or edited notes (newest first). Use this when the user asks what they have been working on lately, to pick up where they left off, or to find a note they just touched ("open my last note", "summarise what I worked on today", "what did I change recently"). Read-only; returns each note’s id, title, and when it was last updated.',
      'recent_notes',
      JSON.stringify(['notes', 'weavenotes', 'desktop']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'recent_notes'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'recent_notes'])]));
    }
  } catch { /* ignore */ }
}
