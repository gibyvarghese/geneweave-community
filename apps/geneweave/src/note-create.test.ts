// SPDX-License-Identifier: MIT
/**
 * Tests for `agentCreateNote` (weaveNotes Phase 3.1) — the create_note tool helper.
 * Proves a new note is created, owned by the user, with the agent's Markdown rendered
 * into a real ProseMirror doc (headings / bullets / to-dos), retrievable + co-editable.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { agentCreateNote } from './note-ai-sql.js';
import { createNoteCoeditRepo } from './note-coedit-sql.js';
import { createToolRegistry } from './tools.js';

function tmpDb(): string { return join(tmpdir(), `gw-notecreate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}

describe('agentCreateNote', () => {
  it('creates a note owned by the user, seeded with the agent\'s Markdown', async () => {
    const db = await makeDb();
    const md = '# Majorana qubits\n\nKey points:\n\n- Topological protection\n- Non-Abelian statistics\n\n- [ ] Read the 2026 review';
    const r = await agentCreateNote(db, { userId: 'alice', title: 'Majorana research', markdown: md });
    expect(r.ok).toBe(true);
    expect(r.noteId).toBeTruthy();

    // The note exists, is owned by alice, and the content rendered into real blocks.
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note).toBeTruthy();
    expect(note!.title).toBe('Majorana research');
    expect(note!.owner_user_id).toBe('alice');

    const view = await createNoteCoeditRepo(db).ensureDoc({ noteId: r.noteId!, tenantId: null, ownerId: 'alice', seedPm: JSON.parse(note!.doc_json) });
    const types = view.blocks.map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletListItem');
    expect(types).toContain('taskItem'); // "- [ ]" became a real to-do
    expect(view.markdown).toContain('Topological protection');
  });

  it('creates an empty note when no markdown is given, and defaults a blank title', async () => {
    const db = await makeDb();
    const r = await agentCreateNote(db, { userId: 'bob', title: '   ' });
    expect(r.ok).toBe(true);
    const note = await db.getNote(r.noteId!, 'bob');
    expect(note!.title).toBe('Untitled note');
    expect(note!.doc_json).toContain('"type":"doc"');
  });

  it('another user cannot read the created note (owner-scoped)', async () => {
    const db = await makeDb();
    const r = await agentCreateNote(db, { userId: 'alice', title: 'Private', markdown: 'secret plan' });
    expect(await db.getNote(r.noteId!, 'mallory')).toBeNull();
  });
});

describe('note-agent tools are always available (regardless of the chat\'s saved tool selection)', () => {
  it('registers create_note / note_edit / note_publish even when toolNames omits them', async () => {
    // Mimic a real user whose chat has a NON-EMPTY saved selection that lacks the note tools.
    const reg = await createToolRegistry(['calculator', 'emit_artifact', 'web_search'], undefined, {
      actorPersona: 'tenant_user', // the chat always passes the user's persona (RBAC-gated)
      currentUserId: 'u1',
      createNote: async () => ({ ok: true, noteId: 'n1' }),
      noteEdit: async () => ({ ok: true }),
      notePublish: async () => ({ ok: true }),
      artifactSave: async () => ({ id: 'a1', version: 1 }),
    });
    // The note tools are present even though they were NOT in the selection…
    expect(reg.get('create_note')).toBeTruthy();
    expect(reg.get('note_edit')).toBeTruthy();
    expect(reg.get('note_publish')).toBeTruthy();
    // …and the selected tools still registered (no double-register breakage).
    expect(reg.get('calculator')).toBeTruthy();
    expect(reg.get('emit_artifact')).toBeTruthy();
  });

  it('does NOT register note tools when their callbacks are not wired', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, { actorPersona: 'tenant_user', currentUserId: 'u1' });
    expect(reg.get('create_note')).toBeUndefined();
    expect(reg.get('note_edit')).toBeUndefined();
  });
});
