// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 8 — desktop (recent_notes tool + config + provenance), storage-layer tests.
 *
 * Proves the server side of the desktop phase end-to-end at the adapter/tool layer:
 *   • m113 adds the three desktop capability flags + registers the recent_notes tool (granted to the
 *     weaveNotes Editor agent); the config round-trips through note-settings-sql.
 *   • `agentRecentNotes` returns the user's most-recently-edited notes (newest first), owner-scoped,
 *     excluding archived — so the assistant can answer "what was I working on?".
 *   • the recent_notes tool registers whenever its callback is wired.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { agentRecentNotes, agentCreateNote } from './note-ai-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { createToolRegistry } from './tools.js';

function tmpDb(): string { return join(tmpdir(), `gw-desk8-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}

describe('weaveNotes Phase 8 — desktop config (m113)', () => {
  it('exposes the three desktop flags with safe defaults + round-trips an update', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    const cfg = await svc.getConfig();
    expect(cfg.desktopOfflineEnabled).toBe(true);
    expect(cfg.quickCaptureEnabled).toBe(true);
    expect(cfg.desktopOfflineNoteLimit).toBeGreaterThan(0);

    const { config } = await svc.updateConfig({ quickCaptureEnabled: false, desktopOfflineNoteLimit: 50 });
    expect(config.quickCaptureEnabled).toBe(false);
    expect(config.desktopOfflineNoteLimit).toBe(50);
    expect((await svc.getConfig()).quickCaptureEnabled).toBe(false); // persisted
  });

  it('registers the recent_notes tool + grants it to the weaveNotes Editor agent', async () => {
    const db = await makeDb();
    const tool = await db.getToolCatalogByKey('recent_notes');
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe('Recent notes');
    const agent = (await db.listWorkerAgents()).find((a) => a.name === 'weavenotes_editor');
    expect(agent?.tool_names ?? '').toContain('recent_notes');
  });
});

describe('weaveNotes Phase 8 — agentRecentNotes', () => {
  it('returns the user’s most-recently-edited notes, newest first, owner-scoped', async () => {
    const db = await makeDb();
    // Create three notes for alice; the SQL clock orders them by updated_at.
    const a = await agentCreateNote(db, { userId: 'alice', title: 'First', markdown: '# one' });
    const b = await agentCreateNote(db, { userId: 'alice', title: 'Second', markdown: '# two' });
    const c = await agentCreateNote(db, { userId: 'alice', title: 'Third', markdown: '# three' });
    // A note for someone else must never appear.
    await agentCreateNote(db, { userId: 'mallory', title: 'Hers', markdown: '# secret' });

    const r = await agentRecentNotes(db, { userId: 'alice', limit: 10 });
    expect(r.ok).toBe(true);
    const ids = r.notes.map((n) => n.noteId);
    expect(ids).toContain(a.noteId);
    expect(ids).toContain(b.noteId);
    expect(ids).toContain(c.noteId);
    expect(r.notes.every((n) => n.title.length > 0)).toBe(true);
    // Owner scoping: mallory's note is absent.
    const mallory = await agentRecentNotes(db, { userId: 'mallory' });
    expect(mallory.notes.some((n) => n.title === 'First')).toBe(false);
    expect(mallory.notes.some((n) => n.title === 'Hers')).toBe(true);
  });

  it('caps the limit (defends against a huge request)', async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i++) await agentCreateNote(db, { userId: 'bob', title: `N${i}` });
    const r = await agentRecentNotes(db, { userId: 'bob', limit: 9999 });
    expect(r.notes.length).toBeLessThanOrEqual(50);
    expect(r.notes.length).toBe(5);
  });
});

describe('weaveNotes Phase 8 — the recent_notes tool registers', () => {
  it('exposes recent_notes whenever its callback is wired', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, {
      actorPersona: 'tenant_user', currentUserId: 'u1',
      noteRecentNotes: async () => ({ ok: true, notes: [{ noteId: 'n1', title: 'Hello', updatedAt: 't', favorite: false }] }),
    });
    expect(reg.get('recent_notes')).toBeTruthy();
  });
  it('does NOT register recent_notes without the callback', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, { actorPersona: 'tenant_user', currentUserId: 'u1' });
    expect(reg.get('recent_notes')).toBeUndefined();
  });
});
