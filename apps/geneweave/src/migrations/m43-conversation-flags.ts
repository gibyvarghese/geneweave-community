/**
 * Migration m43 — Conversation list flags (SP2, mobile)
 *
 * Adds user-controllable list-management flags to the chats table so the
 * user-scoped conversation surface (GET/PATCH /api/me/conversations) can
 * support pin and archive without a separate table:
 *
 *   1. chats.pinned   (INTEGER DEFAULT 0) — sticky conversations float to the
 *      top of the list (ORDER BY pinned DESC, updated_at DESC, rowid DESC).
 *   2. chats.archived (INTEGER DEFAULT 0) — hidden from the default list view;
 *      surfaced only via filter=archived or filter=all.
 *
 * Both are pure ALTER TABLE ADD COLUMN — additive and idempotent (a duplicate
 * column on re-run throws and is swallowed by safe()). UUID PKs are already in
 * place on chats; no PK change.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent — column may already exist */ }
}

export function applyM43ConversationFlags(db: BetterSqlite3.Database): void {
  safe(db, 'ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}
