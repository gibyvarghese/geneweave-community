import type BetterSqlite3 from 'better-sqlite3';

/**
 * m96 — Collaboration Phase 3: durable run subscriptions + offline notifications.
 *
 * Phase 1 (presence) is "who is watching RIGHT NOW" — ephemeral. Phase 3 is the
 * opposite: a DURABLE "tell me when this run finishes, even if I close the tab."
 * Four tables, each tenant-isolated by construction:
 *
 * 1. `run_subscriptions` — WHO wants to be told about a run, and over WHICH
 *    channels (`inapp` always implied; plus `email`/`push`/`webhook`).
 *    `UNIQUE(run_id, user_id)` makes subscribing idempotent. Survives restart —
 *    that is the whole point: a notification you owe someone must not live only
 *    in RAM.
 *
 * 2. `notification_feed` — the durable per-user INBOX (the 🔔 bell). One row per
 *    user per notification ("fan-out on write"), so the unread badge is one
 *    COUNT and mark-all-read is one UPDATE. `dedupe_key` (UNIQUE per principal)
 *    collapses re-deliveries of the same event into one row.
 *
 * 3. `notification_outbox` — the TRANSACTIONAL OUTBOX that makes delivery
 *    crash-safe. When a run reaches a terminal state we INSERT one outbox row per
 *    subscriber; a leased relay drains them (in-app feed write + webhook/push
 *    fan-out) and marks each `sent`. A row stuck in `sending` past its lease is
 *    reclaimed, so a crash mid-send never drops or double-sends a notification
 *    (at-least-once + dedupe = effectively once). `idempotency_key` = the
 *    `webhook-id` for outbound webhooks (Standard Webhooks spec).
 *
 * 4. `webhook_endpoints` — registered outbound webhook URLs referenced BY ID
 *    (never inline user URLs in a subscription), each with its own signing
 *    secret. URLs are SSRF-validated at dial time, not just at registration.
 *
 * Plus: extend `collaboration_config` with the relay cadence + retry budget so
 * the durable-delivery tuning is DB-driven (mirrors the Phase 1 presence cadence).
 */
export function applyM96RunSubscriptions(db: BetterSqlite3.Database): void {
  // 1. Durable subscriptions ("notify me when this run finishes").
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_subscriptions (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id   TEXT,
      user_id     TEXT NOT NULL,
      channels    TEXT NOT NULL DEFAULT '["inapp"]',  -- JSON array of channel ids
      created_at  INTEGER NOT NULL,
      UNIQUE(run_id, user_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_subscriptions_run  ON run_subscriptions(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_subscriptions_user ON run_subscriptions(user_id)`);

  // 2. Durable per-user notification feed (the in-app inbox).
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_feed (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT,
      principal_id TEXT NOT NULL,
      category     TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT,
      deep_link    TEXT,                  -- opaque geneweave://… — no tenant/principal ids
      priority     TEXT NOT NULL DEFAULT 'normal',
      dedupe_key   TEXT,                  -- stable per-event key; UNIQUE per principal
      created_at   INTEGER NOT NULL,
      read_at      INTEGER                -- NULL = unread
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_feed_principal ON notification_feed(principal_id, created_at)`);
  // Idempotency: one row per (principal, dedupe_key). Partial index so rows
  // without a dedupe_key are unconstrained.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_feed_dedupe ON notification_feed(principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);

  // 3. Transactional outbox — crash-safe delivery jobs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      tenant_id       TEXT,
      user_id         TEXT NOT NULL,
      channels        TEXT NOT NULL,        -- JSON array, snapshot of the subscription
      payload         TEXT NOT NULL,        -- JSON NotificationMessage
      idempotency_key TEXT NOT NULL,        -- webhook-id; also the feed dedupe key
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed
      attempts        INTEGER NOT NULL DEFAULT 0,
      lease_until     INTEGER,              -- visibility timeout while 'sending'
      next_attempt_at INTEGER NOT NULL,     -- backoff schedule
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      sent_at         INTEGER,
      UNIQUE(run_id, user_id)               -- one delivery per subscriber per run terminal
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_outbox_drain ON notification_outbox(status, next_attempt_at)`);

  // 4. Registered outbound webhook endpoints (referenced by id, never inline).
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT,
      user_id        TEXT NOT NULL,
      url            TEXT NOT NULL,
      signing_secret TEXT NOT NULL,         -- whsec_…  (per-endpoint; supports rotation)
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      revoked_at     INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id)`);

  // 5. DB-driven relay cadence + retry budget (extend the Phase 1 config row).
  for (const col of [
    `notify_relay_sweep_ms INTEGER NOT NULL DEFAULT 5000`,
    `notify_max_attempts INTEGER NOT NULL DEFAULT 6`,
    `notify_lease_ms INTEGER NOT NULL DEFAULT 30000`,
    `notify_base_backoff_ms INTEGER NOT NULL DEFAULT 2000`,
  ]) {
    try { db.exec(`ALTER TABLE collaboration_config ADD COLUMN ${col}`); } catch { /* column exists — idempotent */ }
  }
}
