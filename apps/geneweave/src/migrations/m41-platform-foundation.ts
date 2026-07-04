/**
 * Migration m41 — Platform Foundation W9
 *
 * Adds tables for the /api/me/ user-scope API:
 *   - user_runs          — run lifecycle records per user
 *   - user_run_events    — ordered event log per run (journal)
 *   - user_devices       — device registrations for push notifications
 *   - notification_preferences — per-user notification settings
 *   - mode_labels        — per-surface display mode configurations
 *   - starter_prompts    — per-surface starter prompt definitions
 *
 * All tables use UUID v7 TEXT primary keys (sortable by creation time).
 * Never use INTEGER AUTOINCREMENT for new tables — see copilot-instructions.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM41PlatformFoundation(db: BetterSqlite3.Database): void {

  // ── user_runs ─────────────────────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS user_runs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    tenant_id  TEXT,
    status     TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','running','completed','failed','cancelled')),
    surface    TEXT,
    metadata   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_runs_user_id    ON user_runs(user_id)');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_runs_status     ON user_runs(status)');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_runs_created_at ON user_runs(created_at)');

  // ── user_run_events ───────────────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS user_run_events (
    id         TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
    sequence   INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, sequence)
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_run_events_run_id ON user_run_events(run_id)');
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_run_events_seq    ON user_run_events(run_id, sequence)');

  // ── user_devices ──────────────────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS user_devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    tenant_id    TEXT,
    channel      TEXT NOT NULL CHECK(channel IN ('web-push','apns','fcm')),
    token        TEXT NOT NULL,
    label        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, token)
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id)');

  // ── notification_preferences ──────────────────────────────────────────────
  safe(db, `CREATE TABLE IF NOT EXISTS notification_preferences (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL UNIQUE,
    enabled        INTEGER NOT NULL DEFAULT 1,
    categories     TEXT NOT NULL DEFAULT '[]',
    quiet_hours    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // ── mode_labels ───────────────────────────────────────────────────────────
  // Per-surface display mode labels ("Assistant", "Agent", "Team", …).
  safe(db, `CREATE TABLE IF NOT EXISTS mode_labels (
    id          TEXT PRIMARY KEY,
    surface_id  TEXT NOT NULL,
    mode_key    TEXT NOT NULL,
    label       TEXT NOT NULL,
    description TEXT,
    icon        TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(surface_id, mode_key)
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_mode_labels_surface ON mode_labels(surface_id)');

  // ── starter_prompts ───────────────────────────────────────────────────────
  // Per-surface starter prompts shown when a surface opens.
  safe(db, `CREATE TABLE IF NOT EXISTS starter_prompts (
    id          TEXT PRIMARY KEY,
    surface_id  TEXT NOT NULL,
    label       TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safe(db, 'CREATE INDEX IF NOT EXISTS idx_starter_prompts_surface ON starter_prompts(surface_id)');

  // ── seed default mode labels ──────────────────────────────────────────────
  const defaultModes = [
    { id: 'm41-mode-web-assistant',  surface: 'web',    key: 'assistant', label: 'Assistant', is_default: 1 },
    { id: 'm41-mode-web-agent',      surface: 'web',    key: 'agent',     label: 'Agent',     is_default: 0 },
    { id: 'm41-mode-mobile-assist',  surface: 'mobile', key: 'assistant', label: 'Assistant', is_default: 1 },
    { id: 'm41-mode-desktop-assist', surface: 'desktop',key: 'assistant', label: 'Assistant', is_default: 1 },
  ];
  const insertMode = db.prepare(`
    INSERT OR IGNORE INTO mode_labels (id, surface_id, mode_key, label, is_default)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const m of defaultModes) {
    insertMode.run(m.id, m.surface, m.key, m.label, m.is_default);
  }
}
