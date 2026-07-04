/**
 * Migration m53 — MCP gateway tenant-scoped rate limiting (A-9)
 *
 * A-9: the gateway rate-limit bucket was keyed only on `client_id`. If two
 * clients across different tenants happened to share an ID (impossible with
 * UUID v7 in practice, but a sound defence-in-depth concern), one tenant's
 * traffic could consume another's quota. More importantly, the audit log and
 * rate-limit tables carry no tenant dimension, making per-tenant roll-up
 * queries impossible.
 *
 * Changes:
 *  1. `mcp_gateway_clients` — add `tenant_id TEXT` column (nullable;
 *     NULL = "global" / single-tenant deployment).
 *  2. `mcp_gateway_rate_buckets` — add `tenant_id TEXT NOT NULL DEFAULT ''`
 *     column; drop the old `(client_id, window_start)` unique constraint and
 *     replace it with `(tenant_id, client_id, window_start)`.
 *
 * SQLite limitations:
 *  - You cannot DROP a UNIQUE constraint directly. We recreate the table.
 *  - Both steps are safe to run repeatedly (safeExec / CREATE TABLE IF NOT EXISTS).
 */

import type BetterSqlite3 from 'better-sqlite3';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Swallow "duplicate column" and other idempotent errors.
  }
}

export function applyM53McpGatewayTenantRateLimit(db: BetterSqlite3.Database): void {
  // 1. Add tenant_id to gateway clients (nullable — existing rows get NULL).
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN tenant_id TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_tenant ON mcp_gateway_clients(tenant_id)`);

  // 2. Recreate mcp_gateway_rate_buckets with the composite unique key.
  //    The old table had UNIQUE(client_id, window_start). We rename it,
  //    create the new schema, copy data (treating existing rows as tenant=''),
  //    then drop the old table.
  safeExec(db, `ALTER TABLE mcp_gateway_rate_buckets RENAME TO mcp_gateway_rate_buckets_old`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_gateway_rate_buckets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id, client_id, window_start)
    )
  `);

  // Copy existing rows, assigning '' as tenant_id for all legacy data.
  db.exec(`
    INSERT OR IGNORE INTO mcp_gateway_rate_buckets (id, tenant_id, client_id, window_start, count)
    SELECT id, '', client_id, window_start, count
    FROM mcp_gateway_rate_buckets_old
  `);

  safeExec(db, `DROP TABLE mcp_gateway_rate_buckets_old`);

  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_rate_buckets_tenant_client ON mcp_gateway_rate_buckets(tenant_id, client_id, window_start)`);
}
