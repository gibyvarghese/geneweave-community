import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m146 — Suggested / starter prompts (Round 10).
 *
 * The empty chat used to be a blank screen with a one-line hint. Now it offers CLICKABLE conversation
 * starters — a few curated defaults plus a few PERSONALISED ones drawn from the person's own recent notes +
 * chats — built on the pure @weaveintel/collab `suggested-prompts` core.
 *
 *  • tenant_suggested_prompts — a per-workspace policy: whether starters show at all, whether they may be
 *    personalised from recent notes / recent chats, whether AI-generated starters are allowed, and how many
 *    curated vs personalised to show.
 *
 *  • user_prompt_suggestions — a per-user CACHE of the last AI-generated starters, so the empty chat can show
 *    personalised suggestions instantly (no live LLM call on open); the suggest_prompts tool refreshes it.
 *
 *  • prompt_suggestion_events — an append-only click log (which starter was picked): a lightweight signal for
 *    "which suggestions actually help", and a persistence record of usage.
 *
 *  • suggest_prompts tool → a new weave_starter worker agent + the weaveNotes Editor, so the assistant can
 *    freshen the personalised starters from a plain request, grounded in the user's own recent activity.
 *
 * Idempotent.
 */
export function applyM146SuggestedPrompts(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_suggested_prompts (
      tenant_id           TEXT PRIMARY KEY,
      enabled             INTEGER NOT NULL DEFAULT 1,   -- show starters on the empty chat at all?
      use_recent_notes    INTEGER NOT NULL DEFAULT 1,   -- personalise from the reader's recent notes?
      use_recent_chats    INTEGER NOT NULL DEFAULT 1,   -- ...and their recent chats?
      use_ai              INTEGER NOT NULL DEFAULT 1,    -- allow AI-generated (cached) starters?
      max_curated         INTEGER NOT NULL DEFAULT 4,    -- how many curated defaults to show
      max_personalized    INTEGER NOT NULL DEFAULT 3,    -- how many personalised starters to show
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS user_prompt_suggestions (
      user_id       TEXT PRIMARY KEY,
      tenant_id     TEXT,
      prompts_json  TEXT NOT NULL DEFAULT '[]',   -- cached AI starters [{id,title,prompt,category,source}]
      generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS prompt_suggestion_events (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      tenant_id   TEXT,
      prompt_id   TEXT NOT NULL,
      title       TEXT,
      source      TEXT,                            -- 'curated' | 'note' | 'chat' | 'ai'
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_prompt_events_user ON prompt_suggestion_events(user_id, created_at)`);

  // suggest_prompts — freshen the personalised conversation starters from the user's recent notes + chats.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'suggestions', 'safe', 0, 60000, 12, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000033', 'Suggest conversation starters',
      'Come up with a few good things the user could ask next, personalised to what they have been doing — drawn from their own recent notes and chats. Use this when the user asks "what can you help with?", "give me some ideas", or "suggest some prompts", or to freshen the starter suggestions on their home screen. It returns short starter prompts and also saves them so they appear on the empty chat screen. It only ever reads the caller\'s own recent notes and chats.',
      'suggest_prompts',
      JSON.stringify(['suggestions', 'starters', 'onboarding', 'prompts']),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_starter', 'Conversation starter guide', 'suggestions', ?, ?, ?, 'assistant', ?, NULL, 1, 30, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000034',
      'Suggests personalised things the user could ask next, based on their recent notes and chats.',
      'You help the user get started when they are not sure what to ask. Use suggest_prompts to generate a few short, varied starter prompts grounded in their recent notes and chats, then offer them plainly (as a short list they can pick from). Keep them personal and useful; never invent facts about the user beyond the titles the tool used. If they pick one, just proceed with it.',
      JSON.stringify(['suggest_prompts']),
      JSON.stringify(['what can you help with', 'give me ideas', 'suggest some prompts', 'conversation starters', 'not sure what to ask']),
    );
  } catch { /* ignore */ }

  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'suggest_prompts'])]), agentName);
      }
    } catch { /* ignore */ }
  }
}
