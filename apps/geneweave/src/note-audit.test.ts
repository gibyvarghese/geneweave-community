// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0-B/0-D — audit feed (tenant-scoped, keyset, prune), redaction completeness,
 * and the invite owner-check. Real on-disk SQLite, offline (no LLM).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';

function tmpDb(): string { return join(tmpdir(), `gw-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
async function note(db: SQLiteAdapter, owner: string, tenant: string | null, title: string): Promise<string> {
  const id = newUUIDv7();
  await db.createNote({ id, owner_user_id: owner, tenant_id: tenant, title, doc_json: JSON.stringify({ type: 'doc', content: [] }), is_template: 0, favorite: 0 });
  return id;
}
async function act(db: SQLiteAdapter, noteId: string, tenant: string | null, action: string, actor: string, createdAt: string, summary = ''): Promise<void> {
  await db.recordNoteActivity({ id: newUUIDv7(), note_id: noteId, user_id: 'alice', tenant_id: tenant, action, actor, summary, detail_json: null, created_at: createdAt });
}

describe('Phase 0-B — tenant-scoped audit feed', () => {
  it('listTenantNoteActivity isolates tenants (same user, two tenants)', async () => {
    const db = await makeDb();
    const a = await note(db, 'alice', 'acme', 'Acme note');
    const g = await note(db, 'alice', 'globex', 'Globex note');
    await act(db, a, 'acme', 'created', 'user', '2026-06-01T10:00:00.000Z');
    await act(db, g, 'globex', 'created', 'user', '2026-06-01T10:00:01.000Z');
    const acme = await db.listTenantNoteActivity('acme');
    const globex = await db.listTenantNoteActivity('globex');
    expect(acme.map((r) => r.note_id)).toEqual([a]);
    expect(globex.map((r) => r.note_id)).toEqual([g]);
    // The join surfaces the note title for display.
    expect(acme[0]!.note_title).toBe('Acme note');
  });

  it('keyset pagination returns every row exactly once (no dupes / no gaps)', async () => {
    const db = await makeDb();
    const n = await note(db, 'alice', 'acme', 'N');
    // 25 events with strictly increasing timestamps.
    for (let i = 0; i < 25; i++) await act(db, n, 'acme', 'updated', 'user', `2026-06-01T10:00:${String(i).padStart(2, '0')}.000Z`, `e${i}`);
    const seen = new Set<string>();
    let cursor: { beforeCreatedAt?: string; beforeId?: string } = {};
    for (let page = 0; page < 10; page++) {
      const rows = await db.listTenantNoteActivity('acme', { limit: 10, ...cursor });
      if (rows.length === 0) break;
      for (const r of rows) { expect(seen.has(r.id)).toBe(false); seen.add(r.id); }
      const last = rows[rows.length - 1]!;
      cursor = { beforeCreatedAt: last.created_at, beforeId: last.id };
      if (rows.length < 10) break;
    }
    expect(seen.size).toBe(25); // all rows, each exactly once
  });

  it('filters by action + actor', async () => {
    const db = await makeDb();
    const n = await note(db, 'alice', 'acme', 'N');
    await act(db, n, 'acme', 'created', 'user', '2026-06-01T10:00:00.000Z');
    await act(db, n, 'acme', 'ai_edit', 'ai', '2026-06-01T10:00:01.000Z');
    await act(db, n, 'acme', 'updated', 'user', '2026-06-01T10:00:02.000Z');
    expect((await db.listTenantNoteActivity('acme', { actor: 'ai' })).length).toBe(1);
    expect((await db.listTenantNoteActivity('acme', { action: 'created' })).length).toBe(1);
  });

  it('pruneNoteActivity deletes rows older than the cutoff', async () => {
    const db = await makeDb();
    const n = await note(db, 'alice', 'acme', 'N');
    await act(db, n, 'acme', 'updated', 'user', '2026-01-01T00:00:00.000Z'); // old
    await act(db, n, 'acme', 'updated', 'user', '2026-06-01T00:00:00.000Z'); // recent
    const deleted = await db.pruneNoteActivity('2026-03-01T00:00:00.000Z');
    expect(deleted).toBe(1);
    expect((await db.listTenantNoteActivity('acme')).length).toBe(1);
  });
});
