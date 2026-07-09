import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m153 — Realm state overlay (Tenancy Realm Phase 3).
 *
 * Lets a tenant change a built-in's *disposition* — turn it off, reprioritise it, pin a version —
 * WITHOUT copy-on-write forking it. Today a tenant can't disable a shared built-in skill for itself
 * without editing the row everyone sees; this sidecar fixes that. It stores only the fields a tenant
 * changed (enabled/priority/pinned_version; NULL = inherit), keyed by (tenant_id, family, logical_key).
 * Resolution (in @weaveintel/realm) is per-field nearest-wins down the tenant tree.
 *
 * Shape matches @weaveintel/realm's realmTenantStateDdl. Empty table = today's behaviour (no overlays →
 * everything inherits the shared default), so nothing changes until a tenant sets an overlay. Idempotent.
 * Postgres gets the table via the regenerated POSTGRES_FULL_SCHEMA.
 */
export function applyM153RealmTenantState(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE TABLE IF NOT EXISTS realm_tenant_state (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL,
    family         TEXT NOT NULL,
    logical_key    TEXT NOT NULL,
    enabled        INTEGER,
    priority       INTEGER,
    pinned_version INTEGER,
    updated_at     TEXT NOT NULL
  )`);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_realm_tenant_state_tenant_key ON realm_tenant_state(tenant_id, family, logical_key)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_realm_tenant_state_family_key ON realm_tenant_state(family, logical_key)`);
}
