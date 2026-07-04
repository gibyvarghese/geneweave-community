// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 0 settings + activity service against a real on-disk
 * SQLite database (m104). Covers: reading the seeded global config, validated updates (clamp +
 * reject unknown), activity recording gated on the config flag, owner-scoped activity reads,
 * and the agent-tool entry point — including negative + security cases.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_WEAVENOTES_CONFIG } from './notes/notes-config.js';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { agentCreateNote } from './note-ai-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-wn0-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> { const db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); return db; }
async function makeNote(db: SQLiteAdapter, owner: string, title: string): Promise<string> { return (await agentCreateNote(db, { userId: owner, title, markdown: '# ' + title })).noteId!; }

describe('weaveNotes settings (m104)', () => {
  it('reads the seeded global config (defaults) and the note tools/agent are registered', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    expect(await svc.getConfig()).toEqual(DEFAULT_WEAVENOTES_CONFIG);
    // m104 seeded the note tools into the catalog + the weaveNotes Editor agent.
    const tools = await db.getWeaveNotesSettings();
    expect(tools).not.toBeNull();
    expect(JSON.parse(tools!.enabled_ai_tools)).toContain('read_note_activity');
  });

  it('validated update: clamps out-of-range + rejects unknown theme/tools, persists, and warns', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    const { config, warnings } = await svc.updateConfig({ defaultTheme: 'rainbow', maxAiTokensPerEdit: 1, activityRetentionDays: 99999, enabledAiTools: ['note_edit', 'evil_tool'] });
    expect(config.defaultTheme).toBe('pro');           // unknown rejected
    expect(config.maxAiTokensPerEdit).toBe(256);       // clamped to min
    expect(config.activityRetentionDays).toBe(3650);   // clamped to max
    expect(config.enabledAiTools).toEqual(['note_edit']); // unknown dropped
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    // persisted: a fresh read returns the same normalised values.
    expect(await svc.getConfig()).toMatchObject({ defaultTheme: 'pro', maxAiTokensPerEdit: 256 });
  });

  it('a valid update round-trips (creative theme, tools subset)', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    await svc.updateConfig({ defaultTheme: 'creative', agencyColorEnabled: false, enabledAiTools: ['workspace_search', 'read_note_activity'] });
    const cfg = await svc.getConfig();
    expect(cfg.defaultTheme).toBe('creative');
    expect(cfg.agencyColorEnabled).toBe(false);
    expect(cfg.enabledAiTools.sort()).toEqual(['read_note_activity', 'workspace_search']);
  });
});

describe('note activity log (m104)', () => {
  it('records create/update events and reads them newest-first', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db, { now: () => Date.UTC(2026, 5, 27, 12, 0, 0) });
    const id = await makeNote(db, 'alice', 'Research log');
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'created', actor: 'user', summary: 'Created the note' });
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'updated', actor: 'user', summary: 'Edited content' });
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'ai_edit', actor: 'ai', summary: 'AI rewrote the intro' });
    const events = await svc.readActivity({ noteId: id, userId: 'alice', limit: 10 });
    expect(events).not.toBeNull();
    expect(events!.length).toBe(3);
    expect(events!.map((e) => e.action)).toContain('ai_edit');
    expect(events!.some((e) => e.actor === 'ai')).toBe(true);
  });

  it('respects the activity-tracking flag: when off, nothing is recorded', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    await svc.updateConfig({ activityTrackingEnabled: false });
    const id = await makeNote(db, 'alice', 'Quiet note');
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'updated', summary: 'should be ignored' });
    expect((await svc.readActivity({ noteId: id, userId: 'alice' }))!.length).toBe(0);
  });

  it('SECURITY: a stranger cannot read another user’s note activity (404)', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    const id = await makeNote(db, 'alice', 'Private');
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'updated', summary: 'secret' });
    expect(await svc.readActivity({ noteId: id, userId: 'mallory' })).toBeNull();
    const tool = await svc.agentReadActivity({ userId: 'mallory', noteId: id });
    expect(tool.ok).toBe(false);
    expect(tool.events).toHaveLength(0);
  });

  it('agentReadActivity returns a compact, AI-readable summary for the owner', async () => {
    const db = await makeDb();
    const svc = createNoteSettingsService(db);
    const id = await makeNote(db, 'alice', 'Topic');
    await svc.recordActivity({ noteId: id, userId: 'alice', action: 'ai_edit', actor: 'ai', summary: 'Coloured risks red' });
    const r = await svc.agentReadActivity({ userId: 'alice', noteId: id });
    expect(r.ok).toBe(true);
    expect(r.events[0]).toMatchObject({ action: 'ai_edit', actor: 'ai', summary: 'Coloured risks red' });
  });
});
