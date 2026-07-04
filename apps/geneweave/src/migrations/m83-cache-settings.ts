import type BetterSqlite3 from 'better-sqlite3';

/**
 * m83 — Cache Phase 1: global cache settings (multi-tier / distributed L2).
 *
 * A single-row `cache_settings` table lets an operator control the shared cache
 * topology from the database (no code change):
 *   - l2_enabled / l2_provider     turn the distributed L2 (Redis) on/off
 *   - l1_max_entries / l1_max_bytes size the in-process L1
 *   - l1_ttl_ms                    staleness cap for L1 copies of L2 entries
 *   - key_namespace                Redis key prefix (shared-Redis isolation)
 *   - global_version_token         bump to invalidate EVERY cache key at once
 *   - stampede_protection / metrics_enabled  reserved for later phases
 *
 * The Redis connection URL is intentionally NOT stored here — secrets stay in
 * the `REDIS_URL` environment variable.
 */
export function applyM83CacheSettings(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_settings (
      id TEXT PRIMARY KEY DEFAULT 'global',
      l2_enabled INTEGER NOT NULL DEFAULT 0,
      l2_provider TEXT NOT NULL DEFAULT 'none',
      l1_max_entries INTEGER NOT NULL DEFAULT 5000,
      l1_max_bytes INTEGER NOT NULL DEFAULT 0,
      l1_ttl_ms INTEGER NOT NULL DEFAULT 30000,
      key_namespace TEXT NOT NULL DEFAULT 'weave:cache',
      global_version_token TEXT NOT NULL DEFAULT 'v1',
      stampede_protection INTEGER NOT NULL DEFAULT 0,
      metrics_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Seed the single global row if absent.
  db.prepare(
    `INSERT OR IGNORE INTO cache_settings (id, l2_enabled, l2_provider, l1_max_entries, l1_max_bytes, l1_ttl_ms, key_namespace, global_version_token, stampede_protection, metrics_enabled)
     VALUES ('global', 0, 'none', 5000, 0, 30000, 'weave:cache', 'v1', 0, 1)`,
  ).run();
}
