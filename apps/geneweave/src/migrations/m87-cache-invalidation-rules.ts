import type BetterSqlite3 from 'better-sqlite3';

/**
 * m87 — Cache Phase 5: event-driven invalidation rules.
 *
 * `cache_invalidation_rules` drives the (now live) invalidation engine: each rule
 * fires on a domain event (`trigger`) and clears cache entries per its `config`
 * JSON (`clearAll`, `prefix`, `prefixFromPayload`, `scope`, `query`, ...). This
 * replaces the overloaded `cache_policies.invalidate_on` JSON.
 *
 * Seeds sensible defaults so prompt-template / model-pricing / knowledge changes
 * invalidate the cache out of the box.
 */
export function applyM87CacheInvalidationRules(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_invalidation_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      pattern TEXT,
      config TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_invalidation_trigger ON cache_invalidation_rules(trigger) WHERE enabled = 1`);

  const seed = db.prepare(
    `INSERT OR IGNORE INTO cache_invalidation_rules (id, name, trigger, pattern, config, enabled) VALUES (?, ?, ?, NULL, ?, 1)`,
  );
  const rules: Array<[string, string, string, Record<string, unknown>]> = [
    ['cir-model-change', 'Model pricing changed → clear response cache', 'model_change', { clearAll: true }],
    ['cir-prompt-update', 'Prompt template updated → clear response cache', 'prompt_update', { clearAll: true }],
    ['cir-knowledge-update', 'Knowledge / source updated → clear response + semantic cache', 'knowledge_update', { clearAll: true }],
    ['cir-session-end', 'Session ended → erase that user\'s cached entries', 'session_end', { prefixFromPayload: 'scopePrefix' }],
    ['cir-preference-change', 'User preference changed → erase that user\'s cached entries', 'preference_change', { prefixFromPayload: 'scopePrefix' }],
  ];
  for (const [id, name, trigger, config] of rules) seed.run(id, name, trigger, JSON.stringify(config));
}
