import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m138 — Answer citations in chat (Round 3 / H17).
 *
 * Brings the notes "Ask your workspace" VERIFIED-citation engine to the CHAT surface: when a reader turns on
 * "Cite sources", the assistant answers their question grounded in THEIR OWN workspace (notes + past chats)
 * and every claim is backed by an inline [n] pointing at a source card whose quote provably exists in that
 * source (hallucinated quotes are dropped — reuses @weaveintel/notes verifyCitations). This migration adds:
 *
 *  • message_citations — one row per VERIFIED citation on an assistant message: which source (note/run) it
 *    came from, the exact quote, and the character span in the source. Durable + queryable, so the answer's
 *    grounding survives a reload and an agent/audit can see exactly what was cited.
 *
 *  • tenant_chat_citations — per-tenant config: whether cited answers are offered at all, how many distinct
 *    sources an answer must cite to count as "grounded" (the strictness dial → enforceCitationStrictness),
 *    and which corpus to search (notes only / past chats only / all).
 *
 *  • the cite_sources tool (answers a question with verified workspace citations) granted to a new
 *    weave_librarian worker agent + the general weaveNotes Editor, so the assistant can ground an answer
 *    itself ("answer that from my notes, with sources") and understands which notes it drew on.
 *
 * Idempotent.
 */
export function applyM138AnswerCitations(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS message_citations (
      id            TEXT PRIMARY KEY,
      message_id    TEXT NOT NULL,
      chat_id       TEXT,
      user_id       TEXT NOT NULL,
      tenant_id     TEXT,
      n             INTEGER NOT NULL,          -- the [n] source number as shown to the reader
      source_id     TEXT NOT NULL,             -- note id / run id the UI opens
      source_kind   TEXT NOT NULL,             -- 'note' | 'run'
      source_title  TEXT NOT NULL,
      quote         TEXT NOT NULL,             -- verbatim text (verified to exist in the source)
      char_start    INTEGER NOT NULL,
      char_end      INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_citations_msg ON message_citations(message_id)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_chat_citations (
      tenant_id       TEXT PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 1,
      min_citations   INTEGER NOT NULL DEFAULT 1,       -- distinct sources required to call an answer "grounded"
      scope           TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'notes' | 'runs'
      max_sources     INTEGER NOT NULL DEFAULT 6,       -- how many sources to retrieve/cite
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // cite_sources tool — a grounded, verified-citation answer over the user's own workspace.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'knowledge', 'safe', 0, 45000, 20, 1, ?, '1.0', 0, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000027', 'Cite sources',
      'Answer a question using ONLY the user\'s own workspace (their notes + past chats), with an inline [n] citation on every claim that points to the exact source sentence. Each quote is verified to genuinely exist in its source, and any the model invents are dropped — so the answer is grounded and checkable, never made up. Use this when the user asks something that should be answered from THEIR material ("what did we decide about pricing? cite it", "answer from my notes"), or asks you to back a claim with a source. Returns the answer text, the verified citations, and the sources.',
      'cite_sources',
      JSON.stringify(['citations', 'rag', 'knowledge', 'grounding']),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_librarian', 'Workspace librarian', 'knowledge', ?, ?, ?, 'assistant', ?, NULL, 1, 30, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000028',
      'Answers questions strictly from the user’s own notes and past chats, with a verifiable source behind every claim.',
      'You answer from the user’s own workspace only. Use cite_sources to get a grounded answer with verified [n] citations, and present it faithfully — never add claims that aren’t backed by a source, and if nothing in their workspace covers the question, say so plainly instead of guessing. Each [n] points to a real note or past chat the user can open and check.',
      JSON.stringify(['cite_sources', 'workspace_search', 'find_related_notes']),
      JSON.stringify(['cite', 'with sources', 'from my notes', 'according to my notes', 'back that up']),
    );
  } catch { /* ignore */ }

  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'cite_sources'])]), agentName);
      }
    } catch { /* ignore */ }
  }
}
