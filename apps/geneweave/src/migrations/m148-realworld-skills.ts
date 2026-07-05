import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m148 — Real-world, tool-bound skills + the columns the mid-2026 @weaveintel/skills 0.1.2 engine
 * uses (composition, trust tier, input modalities).
 *
 * Until now the `skills` catalogue held advisory guidance. This seeds skills that actually DO things:
 * each one is bound to REAL tools that exist in the tool registry (cse_run_data_analysis, web_search,
 * create_diagram, …), so when the assistant (or a supervisor's worker) activates a skill it also gains
 * exactly the tools that skill needs and is told to use them for real results, not estimates.
 *
 * It also adds the columns the 0.1.2 engine reads so the app can use its new capabilities:
 *   • composition (provides / requires / precondition / composes_with / conflicts_with / trust) so
 *     resolveSkillGraph() can order a multi-skill plan (e.g. analyse → report) — Phase 1;
 *   • trust_tier so the security gates + tiers can gate what a skill may do — Phase 3;
 *   • input_modalities so an image-only skill isn't offered for a text request — Phase 6.
 *
 * All columns are nullable/defaulted and every write is INSERT OR IGNORE / additive, so re-running is a
 * no-op and existing skills are untouched. Idempotent.
 */
export function applyM148RealworldSkills(db: BetterSqlite3.Database): void {
  // ── 1. Additive columns the 0.1.2 engine understands (safeExec = ignore "duplicate column") ──
  for (const col of [
    "ALTER TABLE skills ADD COLUMN provides TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skills ADD COLUMN requires TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skills ADD COLUMN precondition TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skills ADD COLUMN composes_with TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skills ADD COLUMN conflicts_with TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skills ADD COLUMN trust INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE skills ADD COLUMN input_modalities TEXT NOT NULL DEFAULT '[\"text\"]'",
    "ALTER TABLE skills ADD COLUMN trust_tier INTEGER NOT NULL DEFAULT 1",
  ]) safeExec(db, col);

  // ── 2. Real, tool-bound skills. `tools` are REAL registered tool names. ──
  type Seed = {
    id: string; name: string; description: string; category: string;
    triggers: string[]; instructions: string; tools: string[]; tags: string[];
    priority?: number; provides?: string[]; requires?: string[]; precondition?: string[];
    composesWith?: string[]; modalities?: string[]; trustTier?: number;
  };
  const SKILLS: Seed[] = [
    {
      id: 'live-data-analysis',
      name: 'Live Data Analysis',
      description: 'Compute real statistics and trends over a dataset the user shares, using the code sandbox — never estimate the numbers.',
      category: 'data-analysis',
      triggers: ['analyse this data', 'what are the trends', 'summarise these numbers', 'compute the stats', 'crunch these figures', 'what does the data say'],
      instructions: 'When the user shares data or numbers, ALWAYS run `cse_run_data_analysis` (or `cse_run_code`) to compute the real result — never guess or estimate. Report the exact computed figures and say what you calculated.',
      tools: ['cse_run_data_analysis', 'cse_run_code', 'calculator'],
      tags: ['analytics', 'auto-on-tabular'],
      provides: ['analysis.done'],
      priority: 10,
      trustTier: 2, // runs sandboxed code
    },
    {
      id: 'analysis-report',
      name: 'Analysis Report Writer',
      description: 'Write up the findings from a completed data analysis as a clear, saved note or artifact.',
      category: 'data-analysis',
      triggers: ['write up the findings', 'turn this analysis into a report', 'summarise the results'],
      instructions: 'Once an analysis has been computed, write a plain-language report of the findings and save it with `create_note` or `emit_artifact`. Reference the actual computed numbers.',
      tools: ['create_note', 'export_note', 'emit_artifact'],
      tags: ['analytics', 'writing'],
      requires: ['live-data-analysis'],
      precondition: ['analysis.done'],
      priority: 5,
    },
    {
      id: 'web-research',
      name: 'Web Research',
      description: 'Research a topic using live web search and give an answer with real sources cited.',
      category: 'research',
      triggers: ['research', 'look this up online', 'find sources on', 'what does the web say about', 'find recent information about'],
      instructions: 'Use `web_search` to find current information and `capture_web_page` to read a promising result, then use `cite_sources` so every factual claim carries a real source. Do not answer from memory alone for time-sensitive topics.',
      tools: ['web_search', 'capture_web_page', 'cite_sources'],
      tags: ['research'],
      provides: ['sources.gathered'],
      priority: 8,
    },
    {
      id: 'visual-explainer',
      name: 'Visual Explainer',
      description: 'Explain something with a diagram or illustration instead of only words.',
      category: 'creative',
      triggers: ['draw a diagram', 'visualise this', 'make a chart of', 'show me a picture of', 'illustrate'],
      instructions: 'When a concept is easier shown than told, create a native editable diagram with `create_diagram`, an illustration with `create_illustration`, or emit a visual artifact with `emit_artifact`.',
      tools: ['create_diagram', 'create_illustration', 'emit_artifact'],
      tags: ['creative'],
      modalities: ['text', 'image'],
      priority: 6,
    },
    {
      id: 'knowledge-capture',
      name: 'Knowledge Capture',
      description: 'Capture something the user wants to keep as a note and link it to related notes.',
      category: 'notes',
      triggers: ['save this as a note', 'remember this', 'capture this', 'add to my notes', 'note this down'],
      instructions: 'Create a note with `create_note`, then use `find_related_notes` to link it into the existing knowledge base. Confirm what you saved.',
      tools: ['create_note', 'recent_notes', 'find_related_notes'],
      tags: ['notes'],
      priority: 5,
    },
    {
      id: 'document-summary',
      name: 'Document Summary',
      description: 'Summarise a document or meeting transcript into the key points and action items.',
      category: 'documents',
      triggers: ['summarise this document', 'key points from', 'meeting minutes', 'tl;dr of this', 'what are the takeaways'],
      instructions: 'Search the workspace with `workspace_search` for the relevant material, then produce a faithful summary with the decisions and action items. For meetings use `summarize_meeting`.',
      tools: ['workspace_search', 'summarize_meeting', 'export_note'],
      tags: ['documents'],
      priority: 6,
    },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO skills
      (id, name, description, category, trigger_patterns, instructions, tool_names, examples, tags,
       priority, version, tool_policy_key, enabled,
       provides, requires, precondition, composes_with, conflicts_with, trust, input_modalities, trust_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', NULL, 1, ?, ?, ?, '[]', '[]', 0, ?, ?)
  `);
  for (const s of SKILLS) {
    try {
      insert.run(
        s.id, s.name, s.description, s.category,
        JSON.stringify(s.triggers), s.instructions, JSON.stringify(s.tools),
        JSON.stringify([]), JSON.stringify(s.tags), s.priority ?? 0,
        JSON.stringify(s.provides ?? []), JSON.stringify(s.requires ?? []),
        JSON.stringify(s.precondition ?? []), JSON.stringify(s.modalities ?? ['text']),
        s.trustTier ?? 1,
      );
    } catch { /* ignore — idempotent */ }
  }

  // ── 3. Give the supervisor real workers mapped to these tools (append if missing). ──
  const NEW_WORKERS = [
    { name: 'data_analyst', description: 'Analyses data by running real computations in the sandbox.', tools: ['cse_run_data_analysis', 'cse_run_code', 'calculator'], persona: 'code_executor' },
    { name: 'web_researcher', description: 'Researches topics using live web search and cites sources.', tools: ['web_search', 'capture_web_page', 'cite_sources'], persona: 'agent_worker' },
  ];
  try {
    const row = db.prepare(`SELECT agent_workers FROM a2a_skills WHERE id = 'supervisor-orchestration'`).get() as { agent_workers?: string } | undefined;
    if (row) {
      const current: Array<{ name: string }> = JSON.parse(row.agent_workers || '[]');
      const have = new Set(current.map((w) => w.name));
      const toAdd = NEW_WORKERS.filter((w) => !have.has(w.name));
      if (toAdd.length) {
        db.prepare(`UPDATE a2a_skills SET agent_workers = ?, updated_at = datetime('now') WHERE id = 'supervisor-orchestration'`)
          .run(JSON.stringify([...current, ...toAdd]));
      }
    }
  } catch { /* ignore — supervisor skill may not exist in minimal installs */ }
}
