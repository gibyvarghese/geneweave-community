import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m144 — Loading skeletons preference (Round 8 — CLS & performance).
 *
 * Round 8 stops content jumping around: scroll positions are preserved across a re-render (so the notes list,
 * admin tables and dashboard keep their place), and slow views show a SKELETON (placeholder shapes the same
 * size as the real content) instead of a blank flash — which both feels faster and removes layout shift.
 *
 * Whether a workspace shows those skeletons is a small UX preference (some prefer a plain "Loading…"), so it
 * lives next to the other accessibility defaults in tenant_accessibility. The shimmer is always stilled when
 * "reduce motion" is on (m140) — this just controls whether the placeholder shapes appear at all.
 *
 * Idempotent (guarded ALTER).
 */
export function applyM144Skeletons(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_accessibility (
      tenant_id       TEXT PRIMARY KEY,
      announce_mode   TEXT NOT NULL DEFAULT 'summary',
      reduced_motion  INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const cols = new Set((db.prepare(`PRAGMA table_info(tenant_accessibility)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('show_skeletons')) safeExec(db, `ALTER TABLE tenant_accessibility ADD COLUMN show_skeletons INTEGER NOT NULL DEFAULT 1`);
}
