import type BetterSqlite3 from 'better-sqlite3';

/**
 * m82 — Cache Phase 0 hardening.
 *
 * Adds the columns that let an operator tune the response cache's security and
 * memory behaviour from the database (no code change):
 *   - max_bytes              approximate L1 byte budget (0 = off)
 *   - key_hashing            'sha256' keeps raw prompts out of cache keys
 *   - tenant_isolation       fold tenant id into the key (cross-tenant isolation)
 *   - cache_temperature_gate cache only when effective temperature ≤ this
 *   - output_bypass_patterns JSON — skip caching when the *response* matches
 *
 * Also normalises the legacy seeded policies to secure defaults.
 */
export function applyM82CachePhase0(db: BetterSqlite3.Database): void {
  const alters = [
    `ALTER TABLE cache_policies ADD COLUMN max_bytes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE cache_policies ADD COLUMN key_hashing TEXT NOT NULL DEFAULT 'sha256'`,
    `ALTER TABLE cache_policies ADD COLUMN tenant_isolation INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE cache_policies ADD COLUMN cache_temperature_gate REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE cache_policies ADD COLUMN output_bypass_patterns TEXT`,
  ];
  for (const sql of alters) {
    try { db.prepare(sql).run(); } catch { /* column already exists */ }
  }

  // Backfill secure defaults on any existing rows (older DBs created the table
  // before these columns existed; SQLite fills with the DEFAULT, but be explicit
  // for rows that may predate NOT NULL defaults).
  try {
    db.prepare(
      `UPDATE cache_policies
         SET key_hashing = COALESCE(NULLIF(key_hashing, ''), 'sha256'),
             tenant_isolation = COALESCE(tenant_isolation, 1),
             cache_temperature_gate = COALESCE(cache_temperature_gate, 0),
             max_bytes = COALESCE(max_bytes, 0)`,
    ).run();
  } catch { /* columns guaranteed present above */ }

  // Seed a sensible response-side secret bypass list on EVERY policy that
  // lacks one. Because cache-policy resolution currently selects the
  // highest-priority enabled policy regardless of request scope, the secret
  // patterns must live on all policies (defence-in-depth) so a response that
  // leaks a secret is never written to the cache, whichever policy is active.
  try {
    db.prepare(
      `UPDATE cache_policies
         SET output_bypass_patterns = ?
       WHERE output_bypass_patterns IS NULL OR output_bypass_patterns = '' OR output_bypass_patterns = '[]'`,
    ).run(JSON.stringify(['sk-[A-Za-z0-9]{16,}', 'BEGIN [A-Z ]*PRIVATE KEY', 'AKIA[0-9A-Z]{16}']));
  } catch { /* table empty or columns missing */ }
}
