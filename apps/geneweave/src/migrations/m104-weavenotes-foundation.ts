import type BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_WEAVENOTES_CONFIG } from '../notes/notes-config.js';

/**
 * m104 — weaveNotes Phase 0: the configurable foundation.
 *
 * weaveNotes is configuration-as-data: how the notes AI behaves is a record in the database
 * an admin tunes through the Builder, not hard-coded behaviour. This migration lays that
 * foundation:
 *
 *   - `weavenotes_settings` — a single-row ('global') config table seeded with the safe
 *     defaults from `@weaveintel/notes` (default theme, whether AI changes need approval,
 *     activity tracking + retention, a per-edit token cap, the AI tools the editor agent may
 *     use). Edited via the Builder's "weaveNotes Settings" resource.
 *
 *   - `note_activity` — a small append-only log of what happens to a note (created / updated /
 *     AI-edited / restored …), so the AI can be GIVEN AN UNDERSTANDING OF WHAT CHANGED before
 *     it acts (read via the `read_note_activity` tool). Owner-scoped + tenant-isolated.
 *
 *   - It also REGISTERS the note AI tools in the tool catalog (create_note / note_edit /
 *     find_related_notes / workspace_search / capture_web_page / autofill_database /
 *     read_note_activity) and seeds a **weaveNotes Editor** worker agent that wields them —
 *     so the capability shows up in the Builder (Tool Catalog + Worker Agents) like everything
 *     else, and is governable from there.
 */
export function applyM104WeaveNotesFoundation(db: BetterSqlite3.Database): void {
  // ── 1. weavenotes_settings (single global config row) ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS weavenotes_settings (
      id                              TEXT PRIMARY KEY DEFAULT 'global',
      default_theme                   TEXT    NOT NULL DEFAULT 'pro',     -- 'pro' | 'creative'
      agency_color_enabled            INTEGER NOT NULL DEFAULT 1,
      ai_suggestions_require_approval INTEGER NOT NULL DEFAULT 1,
      activity_tracking_enabled       INTEGER NOT NULL DEFAULT 1,
      activity_retention_days         INTEGER NOT NULL DEFAULT 90,
      max_ai_tokens_per_edit          INTEGER NOT NULL DEFAULT 4000,
      local_model_for_sensitive       INTEGER NOT NULL DEFAULT 0,
      enabled_ai_tools                TEXT    NOT NULL DEFAULT '[]',      -- JSON array of tool keys
      updated_at                      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const d = DEFAULT_WEAVENOTES_CONFIG;
  db.prepare(
    `INSERT OR IGNORE INTO weavenotes_settings
       (id, default_theme, agency_color_enabled, ai_suggestions_require_approval, activity_tracking_enabled,
        activity_retention_days, max_ai_tokens_per_edit, local_model_for_sensitive, enabled_ai_tools)
     VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.defaultTheme, d.agencyColorEnabled ? 1 : 0, d.aiSuggestionsRequireApproval ? 1 : 0, d.activityTrackingEnabled ? 1 : 0,
    d.activityRetentionDays, d.maxAiTokensPerEdit, d.localModelForSensitive ? 1 : 0, JSON.stringify(d.enabledAiTools),
  );

  // ── 2. note_activity (append-only "what changed" log) ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_activity (
      id          TEXT PRIMARY KEY,
      note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      tenant_id   TEXT,
      action      TEXT NOT NULL,                 -- created | updated | ai_edit | ai_suggestion | restored | published | deleted
      actor       TEXT NOT NULL DEFAULT 'user',  -- user | ai
      summary     TEXT,                          -- short, human-readable ("Rewrote the intro")
      detail_json TEXT,                          -- optional structured detail
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_activity_note ON note_activity(note_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_activity_user ON note_activity(user_id, created_at)`);

  // ── 3. Register the note AI tools in the tool catalog ────────────────────────
  // tool_key matches the runtime tool name so the editor agent + the registry line up.
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
       id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source, credential_id,
       config, allocation_class, created_at, updated_at
     ) VALUES (?, ?, ?, 'notes', ?, 0, 60000, 30, 1, ?, '1.0', ?, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
  );
  const NOTE_TOOLS: Array<{ id: string; key: string; name: string; desc: string; risk: string; side: 0 | 1 }> = [
    { id: 'note00000-0000-4000-8000-000000000001', key: 'create_note', name: 'Create note', desc: 'Create a new note for the user and fill it with Markdown content the AI produced (research, a summary, a plan, to-dos).', risk: 'external-side-effect', side: 1 },
    { id: 'note00000-0000-4000-8000-000000000002', key: 'note_edit', name: 'Edit note', desc: 'Write content into one of the user’s notes as a co-author — staged as a track-changes suggestion (or applied directly when explicitly asked).', risk: 'external-side-effect', side: 1 },
    { id: 'note00000-0000-4000-8000-000000000003', key: 'find_related_notes', name: 'Find related notes', desc: 'Semantic search across the user’s notes for the ones most relevant to a query (knowledge-graph navigation). Read-only.', risk: 'read-only', side: 0 },
    { id: 'note00000-0000-4000-8000-000000000004', key: 'workspace_search', name: 'Search workspace', desc: 'Cited RAG search across the user’s notes AND past chat runs; returns numbered sources the AI answers from. Read-only.', risk: 'read-only', side: 0 },
    { id: 'note00000-0000-4000-8000-000000000005', key: 'capture_web_page', name: 'Capture web page', desc: 'Clip a public web page into a new structured note (readable text + provenance). SSRF-guarded.', risk: 'external-side-effect', side: 1 },
    { id: 'note00000-0000-4000-8000-000000000006', key: 'autofill_database', name: 'Auto-fill database', desc: 'AI-fill a column of one of the user’s note databases (tables) with citations.', risk: 'external-side-effect', side: 1 },
    { id: 'note00000-0000-4000-8000-000000000007', key: 'read_note_activity', name: 'Read note activity', desc: 'Read the recent change history of a note (created / updated / AI-edited) so the assistant understands what has been happening before it acts. Read-only.', risk: 'read-only', side: 0 },
  ];
  for (const t of NOTE_TOOLS) {
    try { insertTool.run(t.id, t.name, t.desc, t.risk, t.key, t.side, JSON.stringify(['notes', 'weavenotes'])); } catch { /* ignore */ }
  }

  // ── 4. Seed the weaveNotes Editor worker agent (wields the note tools) ────────
  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents
         (id, name, display_name, job_profile, description,
          system_prompt, tool_names, persona, trigger_patterns,
          task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'agent_worker', NULL, NULL, 1, 50, 'notes', 1)`,
    ).run(
      'note00000-0000-4000-8001-000000000001',
      'weavenotes_editor',
      'weaveNotes Editor',
      'Notes co-author',
      'Co-authors the user’s notes: creates and edits notes, searches the workspace with citations, captures web pages, fills databases, and reads a note’s recent activity so it understands what changed before acting. Every change it proposes is a reviewable suggestion the human accepts or rejects (colour encodes agency: AI content shows in mint with a woven mark).',
      'You are the weaveNotes editor, a calm co-author inside the user’s notes. Before changing a note, read its recent activity to understand what just happened. Propose changes as suggestions for the human to accept or reject — never overwrite silently. Keep responses in sentence case. Cite sources when answering from the workspace. Use light creative formatting where it aids clarity: ==highlight== a key phrase, and put advisories in a callout with GitHub syntax (a line "> [!NOTE]" / "[!TIP]" / "[!WARNING]" followed by the body) — these render as real coloured highlights and callouts in the editor.',
      JSON.stringify(['create_note', 'note_edit', 'find_related_notes', 'workspace_search', 'capture_web_page', 'autofill_database', 'read_note_activity']),
    );
  } catch { /* ignore */ }
}
