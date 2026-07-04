import type BetterSqlite3 from 'better-sqlite3';

/**
 * m89 — Cache Phase 7: stampede protection, cost-aware eviction, negative caching.
 *
 * Adds the DB-tunable knobs (no code change) for the new behaviours:
 *   cache_policies:
 *     - swr_ms           stale-while-revalidate window (0 = off)
 *     - negative_ttl_ms  short-TTL caching of misses/errors (0 = off)
 *     - eviction_policy  per-policy L1 eviction strategy (lru/lfu/fifo/tinylfu/gdsf)
 *   cache_settings:
 *     - l1_eviction_policy  global L1 eviction strategy (drives the shared store)
 *     - l1_negative_ttl_ms  global negative-cache TTL fallback
 *
 * Also ENABLES `stampede_protection` on the global row so concurrent identical
 * requests coalesce to a single backend call out of the box (singleflight is
 * behaviour-preserving — it only collapses duplicate in-flight computations).
 */
export function applyM89CachePhase7(db: BetterSqlite3.Database): void {
  const alters = [
    `ALTER TABLE cache_policies ADD COLUMN swr_ms INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE cache_policies ADD COLUMN negative_ttl_ms INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE cache_policies ADD COLUMN eviction_policy TEXT NOT NULL DEFAULT 'lru'`,
    `ALTER TABLE cache_settings ADD COLUMN l1_eviction_policy TEXT NOT NULL DEFAULT 'lru'`,
    `ALTER TABLE cache_settings ADD COLUMN l1_negative_ttl_ms INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const sql of alters) {
    try { db.prepare(sql).run(); } catch { /* column already exists */ }
  }

  // Backfill secure/sane defaults on existing rows.
  try {
    db.prepare(
      `UPDATE cache_policies
         SET swr_ms = COALESCE(swr_ms, 0),
             negative_ttl_ms = COALESCE(negative_ttl_ms, 0),
             eviction_policy = COALESCE(NULLIF(eviction_policy, ''), 'lru')`,
    ).run();
  } catch { /* columns guaranteed present above */ }

  // Turn stampede protection ON by default (singleflight is safe; it only
  // coalesces duplicate concurrent computations of the same key).
  try {
    db.prepare(`UPDATE cache_settings SET stampede_protection = 1 WHERE id = 'global'`).run();
    db.prepare(`UPDATE cache_settings SET l1_eviction_policy = COALESCE(NULLIF(l1_eviction_policy, ''), 'lru') WHERE id = 'global'`).run();
  } catch { /* cache_settings may not exist yet on an unusual DB */ }
}
