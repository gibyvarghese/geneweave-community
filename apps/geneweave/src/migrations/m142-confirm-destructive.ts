import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m142 — Accessible dialogs + a destructive-action confirmation policy (Round 5).
 *
 * Native browser alert()/confirm() are replaced in the client by an accessible dialog (WAI-ARIA alertdialog,
 * focus-trapped, Esc/return-focus). WHETHER a workspace makes people confirm destructive actions is a real
 * governance choice: most want the "are you sure?" on deletes (default ON, and an admin can keep it on so no
 * one skips it); some power-user workspaces prefer to turn it off for speed. So it's a per-tenant default,
 * extending m140/m141's tenant_accessibility.
 *
 * Idempotent (guarded ALTER).
 */
export function applyM142ConfirmDestructive(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_accessibility (
      tenant_id       TEXT PRIMARY KEY,
      announce_mode   TEXT NOT NULL DEFAULT 'summary',
      reduced_motion  INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const cols = new Set((db.prepare(`PRAGMA table_info(tenant_accessibility)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('confirm_destructive')) safeExec(db, `ALTER TABLE tenant_accessibility ADD COLUMN confirm_destructive INTEGER NOT NULL DEFAULT 1`);
}
