import type BetterSqlite3 from 'better-sqlite3';

export function applyM81ArtifactTenant(db: BetterSqlite3.Database): void {
  try { db.prepare(`ALTER TABLE artifacts ADD COLUMN tenant_id TEXT DEFAULT NULL`).run(); } catch { /* column already exists */ }
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_tenant ON artifacts(tenant_id) WHERE tenant_id IS NOT NULL`).run();
}
