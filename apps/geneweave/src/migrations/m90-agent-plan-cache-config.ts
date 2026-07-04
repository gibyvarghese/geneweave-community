import type BetterSqlite3 from 'better-sqlite3';

/**
 * m90 — Cache Phase 8: Agentic Plan Caching (arXiv:2506.14852).
 *
 * A single-row `agent_plan_cache_config` controls plan-template reuse from the
 * database (no code change): on/off, the similarity threshold a past task's plan
 * must clear to be reused, the minimum executed steps a run needs before its plan
 * is worth caching (skip trivial single-shot answers), capacity, TTL, and the
 * isolation scope (a plan from tenant A is never offered to tenant B).
 *
 * Enabled by default — it activates only when an embedding model is available
 * (OPENAI_API_KEY) and only for agent / supervisor turns, falling back to a no-op
 * otherwise.
 */
export function applyM90AgentPlanCacheConfig(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_plan_cache_config (
      id TEXT PRIMARY KEY DEFAULT 'global',
      enabled INTEGER NOT NULL DEFAULT 1,
      similarity_threshold REAL NOT NULL DEFAULT 0.86,
      min_steps INTEGER NOT NULL DEFAULT 2,
      max_entries INTEGER NOT NULL DEFAULT 1000,
      ttl_ms INTEGER NOT NULL DEFAULT 86400000,
      scope TEXT NOT NULL DEFAULT 'user',
      embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO agent_plan_cache_config
       (id, enabled, similarity_threshold, min_steps, max_entries, ttl_ms, scope, embedding_model)
     VALUES ('global', 1, 0.86, 2, 1000, 86400000, 'user', 'text-embedding-3-small')`,
  ).run();
}
