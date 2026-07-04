import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m141 — Focus & keyboard accessibility (Round 4).
 *
 * The client fixes (focus preserved across a full re-render so keyboard/screen-reader users don't lose their
 * place; div-as-button controls made operable; overlay triggers announce their state; selected items marked
 * with aria-current; a visible focus ring on every control) are code. The one thing a WORKSPACE governs is
 * whether to force focus rings on for everyone — some accessibility policies want the focus outline always
 * visible, even for mouse users — so that's a per-tenant default here, extending m140's tenant_accessibility.
 *
 * Idempotent (ALTER TABLE ADD COLUMN throws if the column already exists → guarded).
 */
export function applyM141AccessibilityFocus(db: BetterSqlite3.Database): void {
  // Ensure the base table exists (m140), then add the new column if missing.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_accessibility (
      tenant_id       TEXT PRIMARY KEY,
      announce_mode   TEXT NOT NULL DEFAULT 'summary',
      reduced_motion  INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const cols = new Set((db.prepare(`PRAGMA table_info(tenant_accessibility)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('always_show_focus')) safeExec(db, `ALTER TABLE tenant_accessibility ADD COLUMN always_show_focus INTEGER NOT NULL DEFAULT 0`);
}
