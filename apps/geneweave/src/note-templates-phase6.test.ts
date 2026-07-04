// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 6 — templates + organisation (archive/trash).
 *
 * Proves the package→app seam end-to-end at the storage layer:
 *   • m111 SEEDS the system templates as `notes` rows (is_template=1, template_key, doc_json).
 *   • `new_from_template` (agentNewFromTemplate) creates a real, owner-scoped note from a key,
 *     pre-filled with the template's content — the Phase 6 "Done when: New note → Meeting minutes
 *     opens the templated page and its action table feeds tasks".
 *   • the meeting-minutes note's action-items become tasks via the existing extract pipeline.
 *   • archive / restore soft-delete: archived notes leave listNotes but show under the archived
 *     filter, and a restore brings them back. Owner-scoped throughout.
 *
 * Negative + security: unknown template key is rejected (with the available keys); a non-owner
 * can neither read, archive, nor restore another user's note.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SYSTEM_TEMPLATES, templateByKey } from './notes/templates.js';
import { SQLiteAdapter } from './db-sqlite.js';
import { agentNewFromTemplate } from './note-ai-sql.js';
import { extractTaskItems } from '@weaveintel/notes';
import { createToolRegistry } from './tools.js';

function tmpDb(): string { return join(tmpdir(), `gw-tmpl6-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}

describe('weaveNotes Phase 6 — m111 seeds the system templates', () => {
  it('seeds one notes row per system template (system-owned, is_template=1, with doc_json)', async () => {
    const db = await makeDb();
    const templates = await db.listNoteTemplates();
    // Every package template is seeded (idempotent INSERT OR IGNORE), keyed by template_key.
    for (const tpl of SYSTEM_TEMPLATES) {
      const row = templates.find((t) => t.template_key === tpl.key);
      expect(row, `template "${tpl.key}" seeded`).toBeTruthy();
      expect(row!.is_template).toBe(1);
      expect(row!.owner_user_id).toBe('_system');
      // The seeded doc_json round-trips to the package doc.
      expect(JSON.parse(row!.doc_json).type).toBe('doc');
    }
  });

  it('re-running the migration does not duplicate templates (idempotent)', async () => {
    const db = await makeDb();
    const before = (await db.listNoteTemplates()).filter((t) => t.template_key === 'meeting-minutes').length;
    // initialize() is safe to call again; migrations are INSERT OR IGNORE.
    await db.seedDefaultData();
    const after = (await db.listNoteTemplates()).filter((t) => t.template_key === 'meeting-minutes').length;
    expect(before).toBe(1);
    expect(after).toBe(1);
  });
});

describe('weaveNotes Phase 6 — new_from_template (the agent tool helper)', () => {
  it('creates a meeting-minutes note from the key, owned by the user, with its action items', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'meeting-minutes' });
    expect(r.ok).toBe(true);
    expect(r.templateKey).toBe('meeting-minutes');
    expect(r.title).toBe('Meeting minutes'); // defaults to the template's title

    const note = await db.getNote(r.noteId!, 'alice');
    expect(note).toBeTruthy();
    expect(note!.owner_user_id).toBe('alice');
    expect(note!.is_template).toBe(0); // a real note, not a template
    expect(note!.template_key).toBe('meeting-minutes');

    // "its action table feeds tasks": the seeded doc has task items the extract pipeline picks up.
    const todos = extractTaskItems(JSON.parse(note!.doc_json));
    expect(todos.length).toBeGreaterThan(0);
  });

  it('honours a custom title + seeds the template icon', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'cornell', title: 'Biology 101' });
    expect(r.ok).toBe(true);
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note!.title).toBe('Biology 101');
    expect(note!.icon).toBe(templateByKey('cornell')!.icon);
  });

  it('rejects an unknown template key and returns the available keys (negative)', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'does-not-exist' });
    expect(r.ok).toBe(false);
    expect(r.available).toEqual(SYSTEM_TEMPLATES.map((t) => t.key));
    expect(r.available).toContain('meeting-minutes');
  });

  it('the created note is owner-scoped (another user cannot read it) (security)', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'project-brief' });
    expect(await db.getNote(r.noteId!, 'mallory')).toBeNull();
  });
});

describe('weaveNotes Phase 6 — the new_from_template tool registers', () => {
  it('exposes new_from_template whenever its callback is wired (even if not in the selection)', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, {
      actorPersona: 'tenant_user',
      currentUserId: 'u1',
      noteNewFromTemplate: async () => ({ ok: true, noteId: 'n1', title: 'Meeting minutes', templateKey: 'meeting-minutes' }),
    });
    expect(reg.get('new_from_template')).toBeTruthy();
  });

  it('does NOT register new_from_template when the callback is absent', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, { actorPersona: 'tenant_user', currentUserId: 'u1' });
    expect(reg.get('new_from_template')).toBeUndefined();
  });
});

describe('weaveNotes Phase 6 — archive / restore (soft-delete)', () => {
  it('archives + restores a note, hiding/showing it in listNotes and the archived filter', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'daily-planner' });
    const id = r.noteId!;

    // Active by default.
    expect((await db.listNotes('alice')).some((n) => n.id === id)).toBe(true);
    expect((await db.listNotes('alice', { archived: true })).some((n) => n.id === id)).toBe(false);

    // Archive → leaves the active list, appears under the archived filter.
    expect(await db.archiveNote(id, 'alice', '2026-06-25 10:00:00')).toBe(true);
    expect((await db.listNotes('alice')).some((n) => n.id === id)).toBe(false);
    const trash = await db.listNotes('alice', { archived: true });
    expect(trash.some((n) => n.id === id)).toBe(true);
    expect(trash.find((n) => n.id === id)!.archived_at).toBe('2026-06-25 10:00:00');
    // Re-archiving is a no-op.
    expect(await db.archiveNote(id, 'alice', '2026-07-01 00:00:00')).toBe(false);

    // Restore → back in the active list.
    expect(await db.restoreNote(id, 'alice')).toBe(true);
    expect((await db.listNotes('alice')).some((n) => n.id === id)).toBe(true);
    expect(await db.restoreNote(id, 'alice')).toBe(false); // already active → no-op
  });

  it('archive + restore are owner-scoped (a non-owner cannot soft-delete) (security)', async () => {
    const db = await makeDb();
    const r = await agentNewFromTemplate(db, { userId: 'alice', templateKey: 'study-sheet' });
    const id = r.noteId!;
    expect(await db.archiveNote(id, 'mallory', '2026-06-25 10:00:00')).toBe(false);
    expect(await db.archiveNote(id, 'alice', '2026-06-25 10:00:00')).toBe(true);
    expect(await db.restoreNote(id, 'mallory')).toBe(false);
    // Still archived after the failed restore attempt.
    expect((await db.listNotes('alice', { archived: true })).some((n) => n.id === id)).toBe(true);
  });
});
