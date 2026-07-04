import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m127 — weaveNotes Phase 2: per-TENANT enterprise GOVERNANCE record.
 *
 * One row per tenant capturing the enterprise trust posture: data residency, no-training, analytics,
 * enforced SSO + protocol, SCIM, activity/audit retention, and legal hold. This RECORDS the tenant's
 * chosen policy; the heavy machinery (customer-managed encryption keys, retention sweeps) already
 * lives elsewhere — the governance service projects this row (plus the existing BYOK/encryption
 * tables) into the standard compliance CHECKLIST shown in the Builder + a per-user posture endpoint.
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 */
export function applyM127TenantGovernance(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_governance (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE,
      data_residency TEXT NOT NULL DEFAULT 'unrestricted',
      allow_model_training INTEGER NOT NULL DEFAULT 1,
      allow_analytics INTEGER NOT NULL DEFAULT 1,
      sso_required INTEGER NOT NULL DEFAULT 0,
      sso_protocol TEXT NOT NULL DEFAULT 'none',
      scim_enabled INTEGER NOT NULL DEFAULT 0,
      activity_retention_days INTEGER NOT NULL DEFAULT 0,
      audit_retention_days INTEGER NOT NULL DEFAULT 365,
      legal_hold INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_governance_tenant ON tenant_governance(tenant_id)`);
}
