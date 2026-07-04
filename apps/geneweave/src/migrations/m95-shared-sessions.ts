import type BetterSqlite3 from 'better-sqlite3';

/**
 * m95 — Collaboration Phase 2: shared sessions + invite links.
 *
 * Turns a single-owner run into a multi-user one. Three tables:
 *
 * 1. `shared_sessions` — one row per shared run: who owns it, which tenant, and
 *    whether it's still `live`. Created when the owner first shares the run.
 *
 * 2. `session_participants` — the durable MEMBERSHIP list: who may access the run
 *    and at what `role` (owner / collaborator / viewer). `UNIQUE(session_id,
 *    user_id)` makes "join via link" idempotent (joining twice is a no-op) and
 *    guarantees one membership per user. `tenant_id` is denormalised for hard
 *    isolation + fast filtering.
 *
 * 3. `session_share_tokens` — the invite LINKS. A token is a 256-bit random value
 *    shown to the owner ONCE; only its SHA-256 **hash** is stored (same principle
 *    as a password / magic link — never persist the secret). A link grants ONE
 *    role on ONE session in ONE tenant, can expire / be revoked, and supports
 *    multiple concurrent tokens so one can be revoked without killing the others.
 *
 * Security model (mid-2026 research): identity is server-derived; the tenant gate
 * runs before any role logic; only the OWNER may share / cancel / manage; a
 * viewer may watch + show presence but not control the run.
 */
export function applyM95SharedSessions(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_sessions (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id        TEXT,
      owner_id         TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'live',   -- 'live' | 'ended'
      max_participants INTEGER NOT NULL DEFAULT 50,
      created_at       INTEGER NOT NULL,
      ended_at         INTEGER,
      UNIQUE(run_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_participants (
      id                   TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
      tenant_id            TEXT,
      user_id              TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'viewer',  -- 'owner' | 'collaborator' | 'viewer'
      joined_at            INTEGER NOT NULL,
      invited_via_token_id TEXT,
      UNIQUE(session_id, user_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_participants_user    ON session_participants(user_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_share_tokens (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
      tenant_id    TEXT,
      role         TEXT NOT NULL DEFAULT 'viewer',
      token_hash   TEXT NOT NULL,           -- SHA-256(token); the plaintext is shown once, never stored
      token_prefix TEXT NOT NULL,           -- short non-secret lookup hint
      max_uses     INTEGER,                 -- NULL = unlimited
      uses         INTEGER NOT NULL DEFAULT 0,
      expires_at   INTEGER,                 -- NULL = no expiry
      revoked_at   INTEGER,
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_share_tokens_hash    ON session_share_tokens(token_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_share_tokens_session ON session_share_tokens(session_id)`);
}
