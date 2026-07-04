import type BetterSqlite3 from 'better-sqlite3';

/**
 * m85 — Cache Phase 3: observability rollup.
 *
 * `cache_metrics` is an hourly rollup of cache effectiveness — response-cache
 * hits/misses and provider prompt-cache token/cost savings — incremented per
 * chat turn (send + stream) and read by the admin Cache Metrics dashboard. It is
 * the cross-instance, persistent source of truth (the in-process metrics sink is
 * a live, per-replica view).
 *
 * Also flips `cache_settings.metrics_enabled` on so the dashboard is populated
 * out of the box.
 */
export function applyM85CacheMetrics(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_metrics (
      window_start TEXT PRIMARY KEY,           -- hourly bucket 'YYYY-MM-DDTHH:00:00Z'
      response_hits INTEGER NOT NULL DEFAULT 0,
      response_misses INTEGER NOT NULL DEFAULT 0,
      prompt_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_saved_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_metrics_window ON cache_metrics(window_start DESC)`);

  // Enable metrics collection by default (the column was a reserved placeholder
  // in m83). Idempotent: a no-op once it is already 1.
  try {
    db.prepare(`UPDATE cache_settings SET metrics_enabled = 1 WHERE id = 'global' AND metrics_enabled = 0`).run();
  } catch { /* cache_settings may not exist on a brand-new DB yet */ }
}
