/**
 * Migration M36 — Complete memory type support
 *
 * Adds:
 *   1. episodic_memory   — per-turn conversation events (raw episodes before consolidation)
 *   2. procedural_memory — agent instruction deltas proposed by curator; approve/reject workflow
 *   3. working_memory_snapshots — durable snapshots of agent in-context scratch state
 *   4. memory_settings  — per-tenant/global toggle config for all memory subsystems
 *
 * Also seeds:
 *   • Tool catalog entries: memory_list_episodes, memory_get_profile
 *   • Default global memory_settings row (all types enabled)
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM36MemoryComplete(db: BetterSqlite3.Database): void {

  // ── 1. episodic_memory ────────────────────────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id     TEXT REFERENCES chats(id) ON DELETE SET NULL,
      tenant_id   TEXT,
      message_role TEXT NOT NULL DEFAULT 'user',
      content     TEXT NOT NULL,
      importance  REAL NOT NULL DEFAULT 0.5,
      tags        TEXT,
      consolidated INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Index for user timeline queries and consolidation sweeps
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_episodic_user_created
    ON episodic_memory(user_id, created_at DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_episodic_consolidation
    ON episodic_memory(consolidated, user_id)`).run();

  // ── 2. procedural_memory ─────────────────────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS procedural_memory (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id         TEXT NOT NULL DEFAULT 'default',
      instruction_delta TEXT NOT NULL,
      proposed_by      TEXT NOT NULL DEFAULT 'consolidation-curator',
      status           TEXT NOT NULL DEFAULT 'proposed',
      confidence       REAL NOT NULL DEFAULT 0.7,
      human_task_id    TEXT,
      applied_at       TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_procedural_user_status
    ON procedural_memory(user_id, status)`).run();

  // ── 3. working_memory_snapshots ──────────────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS working_memory_snapshots (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id   TEXT REFERENCES chats(id) ON DELETE SET NULL,
      agent_id  TEXT NOT NULL DEFAULT 'default',
      content   TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_working_memory_user_agent
    ON working_memory_snapshots(user_id, agent_id, created_at DESC)`).run();

  // ── 4. memory_settings ───────────────────────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS memory_settings (
      id                          TEXT PRIMARY KEY,
      tenant_id                   TEXT UNIQUE,
      enable_semantic             INTEGER NOT NULL DEFAULT 1,
      enable_entity               INTEGER NOT NULL DEFAULT 1,
      enable_episodic             INTEGER NOT NULL DEFAULT 1,
      enable_procedural           INTEGER NOT NULL DEFAULT 1,
      enable_working              INTEGER NOT NULL DEFAULT 1,
      auto_extract_on_turn        INTEGER NOT NULL DEFAULT 1,
      consolidation_enabled       INTEGER NOT NULL DEFAULT 1,
      consolidation_interval_min  INTEGER NOT NULL DEFAULT 60,
      max_episodic_per_user       INTEGER NOT NULL DEFAULT 200,
      max_semantic_per_user       INTEGER NOT NULL DEFAULT 500,
      max_entity_per_user         INTEGER NOT NULL DEFAULT 100,
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Seed global default settings (tenant_id = NULL means global)
  db.prepare(`
    INSERT OR IGNORE INTO memory_settings
      (id, tenant_id, enable_semantic, enable_entity, enable_episodic,
       enable_procedural, enable_working, auto_extract_on_turn,
       consolidation_enabled, consolidation_interval_min,
       max_episodic_per_user, max_semantic_per_user, max_entity_per_user)
    VALUES ('mem-settings-global', NULL, 1, 1, 1, 1, 1, 1, 1, 60, 200, 500, 100)
  `).run();

  // ── 5. Seed new memory tool catalog entries ──────────────────────────────
  const insertTool = db.prepare(`
    INSERT OR IGNORE INTO tool_catalog
      (id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source,
       created_at, updated_at)
    VALUES (?, ?, ?, 'utility', ?, 0, 5000, 60, 1, ?, '1.0', ?, ?, 'builtin',
            datetime('now'), datetime('now'))
  `);

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000006',
    'List Recent Episodes',
    'List the most recent episodic memory events for the current user — a chronological record of past conversation turns. Useful for recalling what was discussed in a prior session.',
    'read-only',
    'memory_list_episodes',
    0,
    JSON.stringify(['memory', 'episodic', 'history', 'timeline']),
  );

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000007',
    'Get User Profile',
    'Return a comprehensive profile of the current user assembled from all memory types — entity facts, semantic memories, and extracted preferences. Use this to personalise a response with full context.',
    'read-only',
    'memory_get_profile',
    0,
    JSON.stringify(['memory', 'profile', 'identity', 'personalization']),
  );
}
