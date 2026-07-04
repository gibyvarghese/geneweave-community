import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m133 — weaveNotes Phase 4: voice / meeting capture.
 *
 * Record a meeting or voice memo → transcribe it → get a structured note (summary + decisions +
 * action-item checkboxes) where every point links back to the exact moment it was said. Stores the
 * TRANSCRIPT, not the audio (the bot-less / Granola privacy posture) — audio is kept only when a
 * workspace opts in.
 *
 *   - note_meetings — one row per captured recording: the timestamped transcript segments, the
 *     structured summary/decisions/action-items, citation-coverage counts, duration, source, and
 *     whether audio was retained. Owner-scoped, tenant-isolated, cascades on note delete.
 *   - weavenotes_settings dials: voice_capture_enabled (on), store_audio (OFF — privacy),
 *     transcription_language ('' = auto-detect), transcription_model ('whisper-1'),
 *     max_recording_seconds (3600).
 *   - the summarize_meeting tool in tool_catalog, granted to the weaveNotes Editor agent, so the
 *     assistant can turn a pasted transcript into a structured note from a normal chat.
 * Idempotent.
 */
export function applyM133VoiceMeeting(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS note_meetings (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      title TEXT NOT NULL DEFAULT 'Meeting notes',
      source TEXT NOT NULL DEFAULT 'recording',
      language TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      segments_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      action_items_json TEXT NOT NULL DEFAULT '[]',
      decisions_json TEXT NOT NULL DEFAULT '[]',
      cited INTEGER NOT NULL DEFAULT 0,
      cite_total INTEGER NOT NULL DEFAULT 0,
      audio_retained INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_note_meetings_note ON note_meetings(note_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_note_meetings_user ON note_meetings(user_id, created_at)`);

  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN voice_capture_enabled INTEGER NOT NULL DEFAULT 1`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN store_audio INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN transcription_language TEXT NOT NULL DEFAULT ''`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN transcription_model TEXT NOT NULL DEFAULT 'whisper-1'`);
  safeExec(db, `ALTER TABLE weavenotes_settings ADD COLUMN max_recording_seconds INTEGER NOT NULL DEFAULT 3600`);

  // Register the summarize_meeting tool + grant it to the weaveNotes Editor agent.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'notes', 'external-side-effect', 0, 60000, 20, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000020', 'Summarize meeting',
      'Turn a meeting or call TRANSCRIPT into a structured note — a short summary, the decisions made, and action items — where each point is backed by a quote from the transcript. Use when the user pastes a transcript or asks to "summarise this meeting/call", "pull the action items out of this transcript", or "make meeting notes from this". Creates a new note and returns its id.',
      'summarize_meeting',
      JSON.stringify(['notes', 'weavenotes', 'meeting', 'transcribe', 'capture']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'summarize_meeting'])]));
    }
  } catch { /* ignore */ }
  try {
    const cfg = db.prepare(`SELECT enabled_ai_tools FROM weavenotes_settings WHERE id = 'global'`).get() as { enabled_ai_tools?: string } | undefined;
    if (cfg) {
      let tools: string[]; try { tools = JSON.parse(cfg.enabled_ai_tools ?? '[]'); } catch { tools = []; }
      db.prepare(`UPDATE weavenotes_settings SET enabled_ai_tools = ?, updated_at = datetime('now') WHERE id = 'global'`).run(JSON.stringify([...new Set([...tools, 'summarize_meeting'])]));
    }
  } catch { /* ignore */ }
}
