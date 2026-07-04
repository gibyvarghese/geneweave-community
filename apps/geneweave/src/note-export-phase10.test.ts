// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 10 — note export (agentExportNote + config + registration), storage-layer tests.
 *
 *   • m114 adds the two export settings + registers the export_note tool (granted to the weaveNotes
 *     Editor agent); the config round-trips through note-settings-sql.
 *   • `agentExportNote` exports a real note to each format (Markdown/HTML/Word/JSON), owner-scoped;
 *     the JSON is a lossless bundle; a stranger cannot export someone else's note.
 *   • the export_note tool registers whenever its callback is wired.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { agentExportNote, agentCreateNote } from './note-ai-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { createToolRegistry } from './tools.js';
import { parseNoteExportBundle } from '@weaveintel/notes';

function tmpDb(): string { return join(tmpdir(), `gw-exp10-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}

describe('weaveNotes Phase 10 — export config (m114)', () => {
  it('exposes export flags with safe defaults + round-trips an update (allow-list filtered)', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    const cfg = await svc.getConfig();
    expect(cfg.exportEnabled).toBe(true);
    expect(cfg.allowedExportFormats).toEqual(['markdown', 'html', 'word', 'json']);

    const { config } = await svc.updateConfig({ exportEnabled: false, allowedExportFormats: ['markdown', 'json', 'pdf'] });
    expect(config.exportEnabled).toBe(false);
    expect(config.allowedExportFormats).toEqual(['markdown', 'json']); // unknown 'pdf' dropped
    expect((await svc.getConfig()).exportEnabled).toBe(false); // persisted
  });

  it('registers the export_note tool + grants it to the weaveNotes Editor agent', async () => {
    const db = await makeDb();
    const tool = await db.getToolCatalogByKey('export_note');
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe('Export note');
    const agent = (await db.listWorkerAgents()).find((a) => a.name === 'weavenotes_editor');
    expect(agent?.tool_names ?? '').toContain('export_note');
  });
});

describe('weaveNotes Phase 10 — agentExportNote', () => {
  it('exports a note to each format, owner-scoped, with a lossless JSON bundle', async () => {
    const db = await makeDb();
    const { noteId } = await agentCreateNote(db, { userId: 'alice', title: 'Launch Plan', markdown: '# Launch Plan\n\nShip it.\n\n- Fast\n- Safe' });

    const md = await agentExportNote(db, { userId: 'alice', noteId: noteId!, format: 'markdown' });
    expect(md.ok).toBe(true);
    expect(md.filename).toBe('launch-plan.md');
    expect(md.content).toContain('# Launch Plan');
    expect(md.content).toContain('Ship it.');

    const html = await agentExportNote(db, { userId: 'alice', noteId: noteId!, format: 'html' });
    expect(html.content).toContain('<!DOCTYPE html>');
    expect(html.filename).toBe('launch-plan.html');

    const word = await agentExportNote(db, { userId: 'alice', noteId: noteId!, format: 'word' });
    expect(word.content).toContain('urn:schemas-microsoft-com:office:word');

    const json = await agentExportNote(db, { userId: 'alice', noteId: noteId!, format: 'json' });
    const bundle = parseNoteExportBundle(json.content!)!;
    expect(bundle.title).toBe('Launch Plan');
    expect(bundle.doc_json.length).toBeGreaterThan(0); // lossless source preserved
  });

  it('defaults to markdown for an unknown format', async () => {
    const db = await makeDb();
    const { noteId } = await agentCreateNote(db, { userId: 'alice', title: 'X', markdown: 'body' });
    const r = await agentExportNote(db, { userId: 'alice', noteId: noteId!, format: 'pdf' });
    expect(r.format).toBe('markdown');
  });

  it('SECURITY: a stranger cannot export someone else’s note', async () => {
    const db = await makeDb();
    const { noteId } = await agentCreateNote(db, { userId: 'alice', title: 'Private', markdown: 'secret' });
    const r = await agentExportNote(db, { userId: 'mallory', noteId: noteId!, format: 'markdown' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|not accessible/i);
  });
});

describe('weaveNotes Phase 10 — the export_note tool registers', () => {
  it('exposes export_note whenever its callback is wired', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, {
      actorPersona: 'tenant_user', currentUserId: 'u1',
      noteExport: async () => ({ ok: true, format: 'markdown', filename: 'n.md', content: '# hi' }),
    });
    expect(reg.get('export_note')).toBeTruthy();
  });
  it('does NOT register export_note without the callback', async () => {
    const reg = await createToolRegistry(['calculator'], undefined, { actorPersona: 'tenant_user', currentUserId: 'u1' });
    expect(reg.get('export_note')).toBeUndefined();
  });
});
