import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m137 — Answer feedback + AI transparency (Round 3.5).
 *
 * This EXTENDS the platform's existing message-feedback subsystem (anyWeave routing Phase 5: the
 * message_feedback table + recordChatFeedbackSignal, which already turns thumbs up/down into a live
 * quality signal that steers model routing). Rather than duplicate it, we add the two things it lacked:
 *
 *  • message_feedback.categories — a small, fixed taxonomy of WHY an answer got a thumbs-down
 *    (see @weaveintel/collab message-feedback: inaccurate / incomplete / didn't-follow / unsafe …).
 *    A free-text "comment" existed; a structured reason did not, so down-votes could not be turned into an
 *    actionable, aggregatable signal. We also add message_feedback.tenant_id so a workspace's feedback can be
 *    summarised without joining every user to their tenant.
 *
 *  • tenant_ai_transparency — per-tenant switches for AI disclosure: whether assistant answers carry an
 *    "AI-generated" label, the disclosure text, whether sensitive-topic content warnings show, and whether
 *    answer feedback is collected at all. Grounded in the EU AI Act Article 50 transparency duty (the
 *    platform already has euaia-transparency guardrails — this makes the UI-level disclosure configurable).
 *
 *  • the review_answer_feedback tool (read-only) granted to a new weave_quality worker agent + the general
 *    agent, so the assistant can UNDERSTAND how its answers are landing ("what are people unhappy with?").
 *
 * Idempotent. The message_feedback table itself is created by m01-m10 / schema-routing; here we only add the
 * two new columns (guarded, because ALTER TABLE ADD COLUMN throws if the column already exists).
 */
export function applyM137AnswerFeedback(db: BetterSqlite3.Database): void {
  // Ensure the base table exists (older DBs seeded via schema-routing already have it; this is a no-op there).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS message_feedback (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL,
      chat_id     TEXT,
      user_id     TEXT,
      signal      TEXT NOT NULL,
      comment     TEXT,
      model_id    TEXT,
      provider    TEXT,
      task_key    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const cols = new Set((db.prepare(`PRAGMA table_info(message_feedback)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('categories')) safeExec(db, `ALTER TABLE message_feedback ADD COLUMN categories TEXT`);
  if (!cols.has('tenant_id'))  safeExec(db, `ALTER TABLE message_feedback ADD COLUMN tenant_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_feedback_tenant ON message_feedback(tenant_id, created_at)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_ai_transparency (
      tenant_id            TEXT PRIMARY KEY,
      show_ai_label        INTEGER NOT NULL DEFAULT 1,
      disclosure_text      TEXT NOT NULL DEFAULT 'AI-generated — may be inaccurate. Check anything important.',
      content_warnings     INTEGER NOT NULL DEFAULT 1,
      feedback_enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // read-only tool: let the assistant see how its answers are landing.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'quality', 'safe', 0, 30000, 20, 1, ?, '1.0', 0, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000025', 'Review answer feedback',
      'See how your recent answers are landing with people in this workspace — the thumbs up/down rate and the most common reasons for down-votes (e.g. "not accurate", "incomplete"). Use this to ground a reflection like "what are people unhappy with lately?" or before changing your approach. Read-only; returns aggregate counts, never individual users.',
      'review_answer_feedback',
      JSON.stringify(['feedback', 'quality', 'analytics']),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_quality', 'Answer-quality reviewer', 'quality', ?, ?, ?, 'assistant', ?, NULL, 1, 30, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000026',
      'Reviews how the assistant’s answers are landing (thumbs + reasons) and summarises what to improve.',
      'You help review answer quality. Use review_answer_feedback to read the aggregate thumbs up/down rate and the top down-vote reasons, then summarise plainly what’s working and what to improve. Never expose individual users — only aggregates.',
      JSON.stringify(['review_answer_feedback']),
      JSON.stringify(['answer feedback', 'how are my answers', 'what are people unhappy with', 'satisfaction']),
    );
  } catch { /* ignore */ }
  // Also grant the read-only review tool to the general chat agent so it can reflect on quality in a normal chat.
  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'review_answer_feedback'])]), agentName);
      }
    } catch { /* ignore */ }
  }
}
