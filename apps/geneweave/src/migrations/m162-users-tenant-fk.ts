// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Phase 0 completion (Section G): a FOREIGN KEY from `users.tenant_id` → `tenants.id`.
 *
 * The `users.tenant_id` column has existed since m01-m10 but carried no referential integrity — a user
 * could name a tenant that doesn't exist. m150 already laid the groundwork "for a future FK": it
 * backfills a `tenants` row for every distinct `users.tenant_id` and normalises `''`→NULL. This is that
 * future FK: it makes the invariant real, so a bad tenant assignment is rejected at write time instead
 * of silently producing an orphaned user.
 *
 * SQLite cannot `ALTER TABLE ADD CONSTRAINT`, so the constraint is added by rebuilding `users`
 * (create-new → copy → drop → rename), the standard 12-step recipe. `users` has MANY inbound foreign
 * keys (sessions, user_preferences, and a dozen tables in m01-m10 all `REFERENCES users(id)`), so the
 * rebuild runs with `foreign_keys=OFF` — otherwise dropping `users` would trip those children. Ids are
 * copied verbatim, so every inbound reference re-links to the rebuilt table by name, and a scoped
 * `foreign_key_check(users)` proves the new constraint holds before we re-enable enforcement.
 *
 * ON DELETE SET NULL: if a tenant is ever deleted, its users fall back to the null/global scope rather
 * than being deleted (CASCADE) or blocking the delete (RESTRICT) — consistent with the realm's
 * "null tenant = global" convention. Idempotent: a DB that already has the FK is skipped untouched.
 */
import type BetterSqlite3 from 'better-sqlite3';

/** The live `users` columns, in a fixed order, that the rebuilt table reproduces. */
const USERS_COLUMNS = [
  'id', 'email', 'name', 'persona', 'tenant_id', 'password_hash', 'created_at',
  'email_bidx', 'email_verified', 'email_verified_at', 'mfa_enabled', 'mfa_totp_secret',
] as const;

interface FkRow { table: string; from: string; to: string }
interface ColRow { name: string }
interface FkViolation { table: string }

export function applyM162UsersTenantFk(db: BetterSqlite3.Database): void {
  // ── idempotent: already has the FK → nothing to do ──────────────────────────
  const existing = db.pragma('foreign_key_list(users)') as FkRow[];
  if (existing.some((fk) => fk.table === 'tenants' && fk.from === 'tenant_id')) return;

  // ── safety: only rebuild a `users` shaped as we expect ──────────────────────
  // If the live table carries a column we don't know about, the copy would silently drop it. Rather than
  // risk data loss, skip the FK on that anomalous DB (the app-level isolation predicate still holds).
  const liveCols = (db.pragma('table_info(users)') as ColRow[]).map((c) => c.name);
  const unknown = liveCols.filter((c) => !USERS_COLUMNS.includes(c as (typeof USERS_COLUMNS)[number]));
  if (unknown.length > 0) {
    console.warn(`[m162] users has unexpected column(s) [${unknown.join(', ')}] — skipping tenant FK to avoid data loss`);
    return;
  }

  // ── de-orphan: guarantee every users.tenant_id references a real tenant ──────
  // m150 already did this, but re-run defensively so the rebuild can never fail on data added since.
  db.exec(`UPDATE users SET tenant_id = NULL WHERE tenant_id = ''`);
  db.exec(`
    INSERT OR IGNORE INTO tenants (id, name, parent_tenant_id, path, depth, status)
    SELECT DISTINCT tenant_id, tenant_id, NULL, '/' || tenant_id || '/', 0, 'active'
    FROM users
    WHERE tenant_id IS NOT NULL AND tenant_id <> '' AND tenant_id NOT IN (SELECT id FROM tenants)
  `);

  // ── rebuild with the FK. Copy only columns present on BOTH tables (a fresh DB may lack a late ALTER
  //    column if migration order ever changes; the intersection keeps the copy correct either way). ──
  const copyCols = USERS_COLUMNS.filter((c) => liveCols.includes(c)).join(', ');

  db.pragma('foreign_keys = OFF'); // no enclosing transaction here, so this takes effect
  try {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          persona TEXT NOT NULL DEFAULT 'tenant_user',
          tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          email_bidx TEXT,
          email_verified INTEGER NOT NULL DEFAULT 0,
          email_verified_at TEXT,
          mfa_enabled INTEGER NOT NULL DEFAULT 0,
          mfa_totp_secret TEXT
        )
      `);
      db.exec(`INSERT INTO users_new (${copyCols}) SELECT ${copyCols} FROM users`);
      db.exec(`DROP TABLE users`);
      db.exec(`ALTER TABLE users_new RENAME TO users`);
      // Recreate the two secondary indexes the rebuild dropped (UNIQUE(email) is inline above).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email_bidx ON users(email_bidx)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users(mfa_enabled)`);
    });
    rebuild();

    // Prove the new constraint holds (checks users.tenant_id → tenants). The de-orphan above guarantees
    // it does; if it somehow doesn't, fail loudly rather than leave a half-applied schema.
    const violations = db.pragma('foreign_key_check(users)') as FkViolation[];
    if (violations.length > 0) {
      throw new Error(`m162: users.tenant_id FK produced ${violations.length} violation(s) after rebuild`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
