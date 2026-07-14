import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m176 — Upgrade Engine (Hardening): `upgrade_telemetry`, a local, PII-free record of upgrade-lifecycle events.
 *
 * The engine already persists rich per-run detail (`upgrade_runs` / `upgrade_details`). This table is the
 * lighter operational stream an operator (or a local OTLP collector) reads to see the *shape* of upgrade
 * activity over time — how often checks are rejected, how apply outcomes trend, how much the version log is
 * pruned — WITHOUT any identifying data. By construction the columns hold only non-identifying operational
 * facts: an event name, an outcome, the release versions, edition/dialect, and aggregate counts as JSON. There
 * is no user id, no key, no path, no payload. Recording is gated by `telemetryEnabled()` (DO_NOT_TRACK /
 * GENEWEAVE_TELEMETRY), and nothing is ever sent off the instance.
 *
 * One new table, idempotent. Postgres via the regenerated schema.
 */
export function applyM176UpgradeTelemetry(db: BetterSqlite3.Database): void {
  safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS upgrade_telemetry (
       id TEXT PRIMARY KEY,
       event TEXT NOT NULL,             -- 'check' | 'apply' | 'verify' | 'rollback' | 'reconcile' | 'prune'
       outcome TEXT,                    -- 'succeeded' | 'succeeded_with_pending' | 'rejected' | 'rolled_back' | …
       edition TEXT,                    -- the instance edition (community | …)
       dialect TEXT,                    -- 'sqlite' | 'postgres'
       from_version TEXT,               -- release version transitioned FROM (nullable)
       to_version TEXT,                 -- release version transitioned TO (nullable)
       counts_json TEXT,                -- aggregate counts only (adopted/published/review/deleted/…) — NO PII
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_upgrade_telemetry_event ON upgrade_telemetry(event, created_at)`);
}
