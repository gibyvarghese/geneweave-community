import type BetterSqlite3 from 'better-sqlite3';

/**
 * m88 — Cache Phase 6: tool-result caching policies.
 *
 * `tool_cache_policies` declares, per tool, whether its result may be cached and
 * for how long. Caching is OPT-IN: only tools listed here with `cacheable = 1`
 * are cached; everything else (and every side-effecting tool) runs every time.
 * Operators tune TTLs / toggle caching from the admin "Tool Cache" tab without a
 * code change.
 *
 * Seeds read-only tools (search / news / market data / HTTP GET / calculator /
 * datetime) with conservative TTLs; write/side-effecting tools are intentionally
 * NOT seeded so they are never cached.
 */
export function applyM88ToolCachePolicies(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_cache_policies (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL UNIQUE,
      cacheable INTEGER NOT NULL DEFAULT 1,
      ttl_ms INTEGER NOT NULL DEFAULT 300000,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_cache_tool ON tool_cache_policies(tool_name) WHERE enabled = 1`);

  const seed = db.prepare(
    `INSERT OR IGNORE INTO tool_cache_policies (id, tool_name, cacheable, ttl_ms, enabled) VALUES (?, ?, 1, ?, 1)`,
  );
  // [id, tool_name, ttl_ms] — read-only tools only. TTLs reflect how fast each
  // source changes: search/news minutes, market data ~1m, reference data longer.
  const policies: Array<[string, string, number]> = [
    ['tcp-web-search', 'web_search', 300_000],     // 5m — web results are stable-ish
    ['tcp-news-search', 'news_search', 180_000],    // 3m — news moves faster
    ['tcp-market-data', 'market_data', 60_000],     // 1m — quotes move quickly
    ['tcp-http-get', 'http_request', 120_000],      // 2m — idempotent GET fetches
    ['tcp-calculator', 'calculator', 600_000],      // 10m — pure function, very cacheable
    ['tcp-datetime', 'datetime', 30_000],           // 30s — time drifts; short TTL
    ['tcp-unit-convert', 'unit_convert', 600_000],  // 10m — pure function
  ];
  for (const [id, toolName, ttlMs] of policies) seed.run(id, toolName, ttlMs);
}
