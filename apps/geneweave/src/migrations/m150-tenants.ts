import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m150 — Tenant entity (Tenancy Realm, Phase 0).
 *
 * Until now a "tenant" was only a free-text label: `tenant_id` is a nullable string on `users` and on
 * the per-tenant config tables (tenant_configs, tenant_governance, tenant_appearance,
 * tenant_encryption_policy, tenant_biks). There was no `tenants` row, no parent, no lifecycle. This
 * migration makes tenants REAL entities with a parent/child tree, backed by the framework primitive
 * in @weaveintel/identity (`tenancy/tenant-hierarchy` — a materialized-path tree that runs identically
 * on SQLite and Postgres). See docs/Tenancy_realm_config.md, Phase 0.
 *
 * The table shape is exactly `tenantHierarchyDdl()` from @weaveintel/identity, so the store there can
 * operate on this table directly in later phases (resolver, drift, state overlay).
 *
 * Migration = a relabel, not a data move:
 *  • Every distinct `tenant_id` you already use becomes a ROOT tenant (`path='/<id>/'`, depth 0).
 *  • Blank/NULL `tenant_id` maps to a synthetic `default` tenant, preserving the single-org experience.
 *  • Names come from `tenant_configs.name` when present, else the id itself.
 *  • `users.tenant_id = ''` is normalised to NULL (empty ≈ "no tenant"), so it lines up with the
 *    existing null-safe isolation gates and — on Postgres — a foreign key can be added cleanly.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE (by id). Safe to run repeatedly.
 * The Postgres side gets the same table via the regenerated POSTGRES_FULL_SCHEMA and the same backfill
 * via db-postgres/seed.ts.
 */
export function applyM150Tenants(db: BetterSqlite3.Database): void {
  // ── the tenants table (identical shape on both engines; all portable types) ──────────────────────
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenants (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      parent_tenant_id TEXT REFERENCES tenants(id),
      path             TEXT NOT NULL,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'active',
      metadata         TEXT NOT NULL DEFAULT '{}',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_path ON tenants(path)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_tenants_parent ON tenants(parent_tenant_id)`);

  // ── always keep a default root, so single-org installs "just work" ───────────────────────────────
  safeExec(db, `
    INSERT OR IGNORE INTO tenants (id, name, parent_tenant_id, path, depth, status)
    VALUES ('default', 'Default', NULL, '/default/', 0, 'active')
  `);

  // ── backfill roots from tenant_configs first (it carries friendly names) ─────────────────────────
  safeExec(db, `
    INSERT OR IGNORE INTO tenants (id, name, parent_tenant_id, path, depth, status)
    SELECT tc.tenant_id, tc.name, NULL, '/' || tc.tenant_id || '/', 0, 'active'
    FROM tenant_configs tc
    WHERE tc.tenant_id IS NOT NULL AND tc.tenant_id <> ''
  `);

  // ── backfill roots from every other tenant_id-bearing table (name defaults to the id) ────────────
  // Each source runs in its own statement so a table missing on an older DB skips only that source.
  for (const src of ['users', 'tenant_governance', 'tenant_appearance', 'tenant_encryption_policy', 'tenant_biks']) {
    safeExec(db, `
      INSERT OR IGNORE INTO tenants (id, name, parent_tenant_id, path, depth, status)
      SELECT DISTINCT s.tenant_id, s.tenant_id, NULL, '/' || s.tenant_id || '/', 0, 'active'
      FROM ${src} s
      WHERE s.tenant_id IS NOT NULL AND s.tenant_id <> ''
    `);
  }

  // ── normalise blank tenant labels to NULL so they align with null-safe isolation + a future FK ───
  safeExec(db, `UPDATE users SET tenant_id = NULL WHERE tenant_id = ''`);
}
