/**
 * Migration m60 — A2A Skills table
 *
 * Moves the hardcoded A2A capability skills (previously in routes/a2a.ts) into a
 * DB-backed `a2a_skills` table so they can be managed at runtime via the admin UI
 * without requiring a code deploy.
 *
 * Table columns:
 *   id               — kebab-case unique identifier; used as the skill id in Agent Cards
 *   name             — human-readable label shown in Agent Card and admin UI
 *   description      — model-facing capability description
 *   tags             — JSON string[] for discovery/search
 *   examples         — JSON string[] of example prompts
 *   input_modes      — JSON string[] of accepted MIME types (text/plain, audio/*, etc.)
 *   output_modes     — JSON string[] of produced MIME types
 *   security_scopes  — JSON string[] of OAuth2 scope tokens required (e.g. ['a2a:chat'])
 *   mode             — execution mode this skill maps to: 'agent' | 'supervisor' | 'ensemble'
 *   required_permission — optional RBAC permission needed (e.g. 'agents:delegate'); null = any user
 *   sort_order       — display/listing order (ASC)
 *   enabled          — 1 = published in Agent Card; 0 = hidden
 *   created_at, updated_at
 *
 * Seeded with the three skills that were previously hardcoded.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.exec(sql); } catch { /* idempotent */ }
}

const INITIAL_SKILLS = [
  {
    id: 'general-chat',
    name: 'General Chat (Agent)',
    description:
      'Single ReAct agent with tool-calling, skill routing, and memory. Accepts text, audio (with transcript), images, CSVs, and PDFs as FilePart attachments. Default mode for all authenticated callers.',
    tags: JSON.stringify(['chat', 'tool-calling', 'agent', 'voice', 'file']),
    examples: JSON.stringify([
      'Analyse this CSV and summarize the top trends',
      'What is the capital of France?',
      '[FilePart audio/wav + metadata.transcript] Transcribe and respond to my voice note',
      '[FilePart image/png] Describe what you see in this image',
    ]),
    input_modes: JSON.stringify([
      'text/plain', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/*',
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*',
      'application/pdf', 'text/csv', 'application/json',
    ]),
    output_modes: JSON.stringify(['text/plain']),
    security_scopes: JSON.stringify(['a2a:chat']),
    mode: 'agent',
    required_permission: null,
    sort_order: 0,
    enabled: 1,
  },
  {
    id: 'supervisor-orchestration',
    name: 'Supervisor Orchestration',
    description:
      'Multi-agent supervisor that delegates to specialized workers. Accepts the same file types as general-chat. Requires agents:delegate permission.',
    tags: JSON.stringify(['supervisor', 'multi-agent', 'orchestration', 'voice', 'file']),
    examples: JSON.stringify([
      'Research the market and then write a report',
      'Analyse this CSV dataset and produce a chart',
    ]),
    input_modes: JSON.stringify([
      'text/plain', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/*',
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*',
      'application/pdf', 'text/csv', 'application/json',
    ]),
    output_modes: JSON.stringify(['text/plain']),
    security_scopes: JSON.stringify(['a2a:supervisor']),
    mode: 'supervisor',
    required_permission: 'agents:delegate',
    sort_order: 1,
    enabled: 1,
  },
  {
    id: 'ensemble-reasoning',
    name: 'Ensemble Reasoning',
    description:
      'Multiple independent agents vote/judge to produce a consensus answer. Requires agents:delegate permission.',
    tags: JSON.stringify(['ensemble', 'multi-agent', 'consensus']),
    examples: JSON.stringify([
      'What is the best approach to caching in distributed systems?',
    ]),
    input_modes: JSON.stringify([
      'text/plain', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/*',
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*',
      'application/pdf', 'text/csv', 'application/json',
    ]),
    output_modes: JSON.stringify(['text/plain']),
    security_scopes: JSON.stringify(['a2a:ensemble']),
    mode: 'ensemble',
    required_permission: 'agents:delegate',
    sort_order: 2,
    enabled: 1,
  },
];

export function applyM60A2ASkills(db: BetterSqlite3.Database): void {
  safe(db, `
    CREATE TABLE IF NOT EXISTS a2a_skills (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      tags                TEXT,
      examples            TEXT,
      input_modes         TEXT,
      output_modes        TEXT,
      security_scopes     TEXT NOT NULL DEFAULT '["a2a:chat"]',
      mode                TEXT NOT NULL DEFAULT 'agent',
      required_permission TEXT,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  safe(db, `CREATE INDEX IF NOT EXISTS idx_a2a_skills_enabled_order ON a2a_skills(enabled, sort_order ASC)`);

  // Seed initial skills — idempotent (INSERT OR IGNORE)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO a2a_skills
      (id, name, description, tags, examples, input_modes, output_modes, security_scopes, mode, required_permission, sort_order, enabled)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of INITIAL_SKILLS) {
    insert.run(
      s.id, s.name, s.description, s.tags, s.examples,
      s.input_modes, s.output_modes, s.security_scopes,
      s.mode, s.required_permission, s.sort_order, s.enabled,
    );
  }
}
