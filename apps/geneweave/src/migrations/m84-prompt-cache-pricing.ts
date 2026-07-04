import type BetterSqlite3 from 'better-sqlite3';

/**
 * m84 — Cache Phase 2: per-model provider-native prompt-cache policy.
 *
 * Adds columns to `model_pricing` so an operator can turn provider prompt
 * caching on/off and tune the breakpoint per model (no code change):
 *   - prompt_cache_enabled    1 = request caching of the stable prefix
 *   - prompt_cache_min_tokens minimum stable-prefix size to bother caching
 *                             (≈1,024 for current Claude/GPT models)
 *   - prompt_cache_ttl        '5m' (default) or '1h' (extended) where supported
 */
export function applyM84PromptCachePricing(db: BetterSqlite3.Database): void {
  const alters = [
    `ALTER TABLE model_pricing ADD COLUMN prompt_cache_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE model_pricing ADD COLUMN prompt_cache_min_tokens INTEGER NOT NULL DEFAULT 1024`,
    `ALTER TABLE model_pricing ADD COLUMN prompt_cache_ttl TEXT NOT NULL DEFAULT '5m'`,
  ];
  for (const sql of alters) {
    try { db.prepare(sql).run(); } catch { /* column already exists */ }
  }
  // Backfill secure defaults on any legacy rows.
  try {
    db.prepare(
      `UPDATE model_pricing
         SET prompt_cache_enabled = COALESCE(prompt_cache_enabled, 1),
             prompt_cache_min_tokens = COALESCE(NULLIF(prompt_cache_min_tokens, 0), 1024),
             prompt_cache_ttl = COALESCE(NULLIF(prompt_cache_ttl, ''), '5m')`,
    ).run();
  } catch { /* columns guaranteed present above */ }

  // Provider-aware: local models (Ollama / llama.cpp) have no provider-native
  // prompt cache, so disable it for them. The `= 1` guard makes this a no-op on
  // every subsequent boot (and never clobbers a cloud model's tuning).
  try {
    db.prepare(
      `UPDATE model_pricing SET prompt_cache_enabled = 0
         WHERE provider IN ('ollama', 'llamacpp') AND prompt_cache_enabled = 1`,
    ).run();
  } catch { /* table may be empty on a brand-new DB */ }
}
