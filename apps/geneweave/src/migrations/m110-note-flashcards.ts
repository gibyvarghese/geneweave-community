import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m110 — weaveNotes Phase 5: AI study (flashcards + SM-2 spaced repetition).
 *
 * The most effective way to remember a note is active recall on a spaced schedule. This migration
 * lays the foundation:
 *
 *   - `note_flashcards` — one row per card: its question (`front`) + answer (`back`) and its SM-2
 *     schedule (`ease_factor`, `interval_days`, `repetitions`, `due_at`, `last_reviewed_at`).
 *     Owner-scoped + tenant-isolated; cascades when the note is deleted; indexed by note + by
 *     (owner, due_at) so "what's due today across all my notes" is a fast lookup.
 *   - two weaveNotes settings: `flashcards_enabled` (Builder toggle) + `daily_new_card_limit`
 *     (how many NEW cards a study session introduces per day — active-recall pacing).
 *   - registers the `make_flashcards` tool in `tool_catalog`, grants it to the weaveNotes Editor
 *     agent, and merges it into `enabled_ai_tools`.
 *
 * Idempotent (CREATE IF NOT EXISTS + safeExec ALTERs + INSERT OR IGNORE + JSON merges).
 */
export function applyM110NoteFlashcards(db: BetterSqlite3.Database): void {
  // ── 1. note_flashcards ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_flashcards (
      id               TEXT PRIMARY KEY,
      note_id          TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      owner_user_id    TEXT NOT NULL,
      tenant_id        TEXT,
      front            TEXT NOT NULL,
      back             TEXT NOT NULL,
      ease_factor      REAL    NOT NULL DEFAULT 2.5,
      interval_days    INTEGER NOT NULL DEFAULT 0,
      repetitions      INTEGER NOT NULL DEFAULT 0,
      due_at           INTEGER NOT NULL,          -- epoch ms; a new card is due immediately
      last_reviewed_at INTEGER,                   -- epoch ms or NULL (never reviewed)
      created_at       INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_flashcards_note ON note_flashcards(note_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_flashcards_due ON note_flashcards(owner_user_id, due_at)`);

  // ── 2. weaveNotes settings flags ─────────────────────────────────────────────
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN flashcards_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN daily_new_card_limit INTEGER NOT NULL DEFAULT 20`);

  // ── 3. Register the make_flashcards tool + grant it ──────────────────────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000011', 'Make flashcards',
      'Turn one of the user’s notes into question→answer flashcards for active-recall study, scheduled with spaced repetition (SM-2). Reads the note and writes a deck of cards the user can review on a schedule. You only need the note id.',
      'make_flashcards',
      JSON.stringify(['notes', 'weavenotes', 'study']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'make_flashcards'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'make_flashcards'])]));
    }
  } catch { /* ignore */ }
}
