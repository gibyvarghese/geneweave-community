/**
 * Migration m54 — EU AI Act Article 12 audit log retention tiering
 *
 * EU AI Act Article 12 requires providers of high-risk AI systems to maintain
 * automatically generated logs for at least 6 months (Annex IX), with national
 * competent authorities requiring up to 10 years for compliance audits.
 * GDPR Article 30 requires processing records to be kept "for as long as
 * necessary" which in practice means 7 years for contractual/regulatory
 * obligations in the EU.
 *
 * Two retention tiers:
 *  - 'operational' (90 days)  — normal monitoring, debugging, usage metrics.
 *    Purged after 90 days to limit storage and reduce breach exposure.
 *  - 'compliance'  (7 years)  — high-risk AI decisions, denied requests,
 *    security events, and any event that may be relevant to regulatory audit.
 *    Retained for 2 555 days (7 × 365) per EU AI Act / GDPR.
 *
 * Changes:
 *  1. `tool_audit_events` — add `retention_tier TEXT NOT NULL DEFAULT 'operational'`.
 *  2. `mcp_gateway_request_log` — add `retention_tier TEXT NOT NULL DEFAULT 'operational'`.
 *  3. New `audit_log_retention_tiers` table — canonical reference for the
 *     retention period per tier. Used by background purge jobs.
 *
 * Application code is responsible for setting `retention_tier = 'compliance'`
 * on insert for events that qualify (e.g. denied tool calls, policy violations,
 * authentication failures, admin actions). The default 'operational' is safe —
 * it under-retains rather than over-retains.
 *
 * All steps are idempotent via safeExec / CREATE TABLE IF NOT EXISTS.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Swallow duplicate-column and already-exists errors (idempotency).
  }
}

/** Canonical retention tier definitions for the purge job. */
const RETENTION_TIERS: Array<{
  tier: string;
  retentionDays: number;
  description: string;
}> = [
  {
    tier: 'operational',
    retentionDays: 90,
    description:
      'Short-term operational logs: debugging, usage metrics, normal tool invocations. Purged after 90 days.',
  },
  {
    tier: 'compliance',
    retentionDays: 2555, // 7 years × 365 days
    description:
      'EU AI Act Article 12 / GDPR compliance logs: denied requests, policy violations, security events, admin actions. Retained for 7 years.',
  },
];

export function applyM54AuditRetentionTiers(db: BetterSqlite3.Database): void {
  // 1. Add retention_tier to tool_audit_events.
  safeExec(db, `ALTER TABLE tool_audit_events ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'operational'`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_retention_tier ON tool_audit_events(retention_tier, created_at)`);

  // 2. Add retention_tier to mcp_gateway_request_log.
  safeExec(db, `ALTER TABLE mcp_gateway_request_log ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'operational'`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_log_retention_tier ON mcp_gateway_request_log(retention_tier, created_at)`);

  // 3. Create the canonical retention tiers reference table.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS audit_log_retention_tiers (
      tier TEXT PRIMARY KEY,
      retention_days INTEGER NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 4. Seed / upsert the two canonical tiers.
  const upsert = db.prepare(`
    INSERT INTO audit_log_retention_tiers (tier, retention_days, description, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(tier) DO UPDATE SET
      retention_days = excluded.retention_days,
      description = excluded.description,
      updated_at = datetime('now')
  `);
  for (const { tier, retentionDays, description } of RETENTION_TIERS) {
    upsert.run(tier, retentionDays, description);
  }

  // 5. Back-fill: mark existing denied/violation tool_audit_events as compliance tier.
  //    These are the highest-value records for regulatory audit. Row counts may
  //    be large on mature deployments — no transaction needed (SQLite auto-commit
  //    per-statement is fine for a migration that runs once).
  safeExec(db, `
    UPDATE tool_audit_events
    SET retention_tier = 'compliance'
    WHERE retention_tier = 'operational'
      AND (outcome IN ('denied', 'error') OR violation_reason IS NOT NULL)
  `);

  // 6. Back-fill: mark denied / unauthorized gateway requests as compliance tier.
  safeExec(db, `
    UPDATE mcp_gateway_request_log
    SET retention_tier = 'compliance'
    WHERE retention_tier = 'operational'
      AND outcome IN ('unauthorized', 'rate_limited', 'error', 'expired')
  `);
}
