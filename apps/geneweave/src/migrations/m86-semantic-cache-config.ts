import type BetterSqlite3 from 'better-sqlite3';

/**
 * m86 — Cache Phase 4: semantic cache configuration.
 *
 * A single-row `semantic_cache_config` controls the embedding-similarity cache
 * from the database (no code change): the embedding model + version, the
 * similarity threshold (conservative 0.92 to avoid false hits), invalidation
 * radius, capacity, TTL, isolation scope, and time-sensitive bypass patterns.
 *
 * Enabled by default — it activates only when an embedding model is available
 * (OPENAI_API_KEY), and falls back to a no-op otherwise.
 */
export function applyM86SemanticCacheConfig(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_cache_config (
      id TEXT PRIMARY KEY DEFAULT 'global',
      enabled INTEGER NOT NULL DEFAULT 1,
      embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      embedding_version TEXT NOT NULL DEFAULT 'v1',
      similarity_threshold REAL NOT NULL DEFAULT 0.92,
      invalidation_radius REAL NOT NULL DEFAULT 0.95,
      max_entries INTEGER NOT NULL DEFAULT 1000,
      ttl_ms INTEGER NOT NULL DEFAULT 600000,
      scope TEXT NOT NULL DEFAULT 'user',
      bypass_patterns TEXT,
      verified_bounds INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO semantic_cache_config
       (id, enabled, embedding_model, embedding_version, similarity_threshold, invalidation_radius, max_entries, ttl_ms, scope, bypass_patterns, verified_bounds)
     VALUES ('global', 1, 'text-embedding-3-small', 'v1', 0.92, 0.95, 1000, 600000, 'user', ?, 0)`,
  ).run(JSON.stringify(['real-time', 'current date', 'current time', 'today', 'right now', 'latest', 'breaking news', 'as of now']));
}
