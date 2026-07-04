// SPDX-License-Identifier: MIT
/**
 * Integration tests — weaveNotes Phase 8 against a real on-disk SQLite database, with a
 * deterministic offline embedder. Covers all four features:
 *   - WORKSPACE RAG: cited search fuses notes (note_embeddings) + runs (run_embeddings);
 *   - VERSION HISTORY: snapshot, list, restore (undoable), owner-scoping;
 *   - BLOCK COMMENTS: threads, replies, edit (author-only), soft-delete, resolve;
 *   - SYNCED BLOCKS: read-through transclusion reflects source edits; self-sync rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { setActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { agentCreateNote } from './note-ai-sql.js';
import { createNoteGraphService } from './note-graph-sql.js';
import { createNoteWorkspaceService } from './note-workspace-sql.js';
import { createNoteVersionService } from './note-version-sql.js';
import { createNoteCommentService } from './note-comment-sql.js';
import { createNoteSyncedService } from './note-synced-sql.js';
import type { NoteAccess } from './note-coedit-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-ws8-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); return db;
}
async function makeNote(db: SQLiteAdapter, owner: string, title: string, markdown: string): Promise<string> {
  const r = await agentCreateNote(db, { userId: owner, title, markdown });
  return r.noteId!;
}
async function makeRun(db: SQLiteAdapter, owner: string, deltas: string[]): Promise<string> {
  const runId = newUUIDv7();
  await db.createUserRun({ id: runId, user_id: owner, status: 'completed' });
  let seq = 0;
  for (const d of deltas) await db.appendUserRunEvent({ id: newUUIDv7(), run_id: runId, sequence: seq++, kind: 'text.delta', payload: JSON.stringify({ delta: d }) });
  return runId;
}
const access = (ownerId: string): NoteAccess => ({ noteId: '', ownerId, tenantId: null, role: 'owner' });
const FIXED = Date.UTC(2026, 5, 27, 12, 0, 0);

// Deterministic embedder: a bag-of-keywords vector so similar topics score high (offline).
const VOCAB = ['tides', 'fundy', 'ocean', 'metres', 'cooking', 'pasta', 'recipe', 'garden', 'quantum'];
function embedText(t: string): number[] { const low = t.toLowerCase(); return VOCAB.map((w) => low.split(w).length - 1); }
const fakeEmbModel = {
  info: { id: 'fake-embed', provider: 'test', name: 'fake', dimensions: VOCAB.length },
  capabilities: () => ['embedding'],
  embed: async (_ctx: unknown, req: { input: readonly string[] }) => ({ embeddings: req.input.map(embedText), model: 'fake', usage: { totalTokens: 0 } }),
};
beforeEach(() => setActiveGuardrailEmbeddingModel(fakeEmbModel as never));
afterEach(() => setActiveGuardrailEmbeddingModel(undefined));

describe('workspace RAG — cited search over notes + runs', () => {
  it('finds and cites BOTH a note and a run on topic, and excludes off-topic content', async () => {
    const db = await makeDb();
    const graph = createNoteGraphService(db);
    const ws = createNoteWorkspaceService(db, { now: () => FIXED });

    const tidesNote = await makeNote(db, 'alice', 'Bay of Fundy', 'The Bay of Fundy has the highest tides on Earth, over sixteen metres.');
    await makeNote(db, 'alice', 'Pasta night', 'A cooking recipe for pasta with garden basil.');
    await graph.indexNote({ noteId: tidesNote, access: access('alice') }); // → note_embeddings
    const offTopic = await makeNote(db, 'alice', 'Garden', 'My garden recipe notes for pasta.');
    await graph.indexNote({ noteId: offTopic, access: access('alice') });

    const tidesRun = await makeRun(db, 'alice', ['We learned the tides in Fundy ', 'reach sixteen metres twice a day.']);
    expect((await ws.indexRun({ runId: tidesRun, userId: 'alice' })).embedded).toBe(true); // → run_embeddings

    const res = await ws.workspaceSearch({ userId: 'alice', query: 'how high are the tides in Fundy', limit: 6 });
    expect(res.sources.length).toBeGreaterThanOrEqual(2);
    const kinds = res.sources.map((s) => s.kind);
    expect(kinds).toContain('note');
    expect(kinds).toContain('run');
    expect(res.context).toMatch(/tides/i);
    // The note + run on-topic outrank the cooking note (which should not be the top source).
    expect(res.sources[0]!.title).not.toBe('Pasta night');
  });

  it('reindexRuns embeds completed runs; scope filters to a single corpus', async () => {
    const db = await makeDb();
    const ws = createNoteWorkspaceService(db, { now: () => FIXED });
    await makeRun(db, 'bob', ['Discussion about ocean tides and metres.']);
    await makeRun(db, 'bob', ['Another run on cooking pasta.']);
    const { indexed } = await ws.reindexRuns({ userId: 'bob' });
    expect(indexed).toBe(2);
    const runsOnly = await ws.workspaceSearch({ userId: 'bob', query: 'tides', scope: 'runs' });
    expect(runsOnly.sources.every((s) => s.kind === 'run')).toBe(true);
    expect(runsOnly.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('SECURITY: a user only searches their own workspace', async () => {
    const db = await makeDb();
    const graph = createNoteGraphService(db);
    const ws = createNoteWorkspaceService(db, { now: () => FIXED });
    const secret = await makeNote(db, 'alice', 'Secret tides', 'Alice private tides research, sixteen metres.');
    await graph.indexNote({ noteId: secret, access: access('alice') });
    const res = await ws.workspaceSearch({ userId: 'mallory', query: 'tides' });
    expect(res.sources).toHaveLength(0); // mallory sees nothing of alice's
  });

  it('SECURITY: a stranger cannot index a run they do not own (404)', async () => {
    const db = await makeDb();
    const ws = createNoteWorkspaceService(db, { now: () => FIXED });
    const runId = await makeRun(db, 'alice', ['private output']);
    const r = await ws.indexRun({ runId, userId: 'mallory' });
    expect(r.ok).toBe(false);
  });
});

describe('version history — snapshot + restore', () => {
  it('saves, lists, and restores a version (undoably)', async () => {
    const db = await makeDb();
    const vs = createNoteVersionService(db, { now: () => FIXED });
    const id = await makeNote(db, 'alice', 'Draft', 'Version one content.');

    const v1 = await vs.saveVersion({ noteId: id, userId: 'alice', label: 'v1' });
    expect(v1.ok).toBe(true);

    // Edit the note, then restore v1.
    await db.updateNote(id, 'alice', { doc_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Totally rewritten.' }] }] }) });
    const restore = await vs.restoreVersion({ noteId: id, versionId: v1.versionId!, userId: 'alice' });
    expect(restore.ok).toBe(true);

    const note = await db.getNote(id, 'alice');
    expect(note!.doc_json).toContain('Version one content');

    // History now has v1 + the auto "before restore" snapshot (which captured the rewrite).
    const versions = await vs.listVersions({ noteId: id, userId: 'alice' });
    expect(versions!.length).toBe(2);
    expect(versions!.some((v) => v.reason === 'restore' && v.label === 'before restore')).toBe(true);
  });

  it('SECURITY: another user cannot snapshot, list, or restore', async () => {
    const db = await makeDb();
    const vs = createNoteVersionService(db, { now: () => FIXED });
    const id = await makeNote(db, 'alice', 'Private', 'secret');
    expect((await vs.saveVersion({ noteId: id, userId: 'mallory' })).code).toBe(404);
    expect(await vs.listVersions({ noteId: id, userId: 'mallory' })).toBeNull();
  });
});

describe('block comments — threads, edit, delete, resolve', () => {
  it('creates a thread + reply, lists them, and resolves the thread', async () => {
    const db = await makeDb();
    const cs = createNoteCommentService(db, { now: () => FIXED });
    const id = await makeNote(db, 'alice', 'Reviewed note', 'Some content to discuss.');

    const root = await cs.create({ noteId: id, userId: 'alice', body: 'Is this **clear**?', anchorBlockId: 'blk-1' });
    expect(root.ok).toBe(true);
    expect(root.comment!.bodyHtml).toContain('<strong>clear</strong>'); // sanitized markdown render
    const reply = await cs.create({ noteId: id, userId: 'alice', body: 'Yes, looks good.', parentId: root.comment!.id });
    expect(reply.comment!.threadId).toBe(root.comment!.id);
    expect(reply.comment!.anchorBlockId).toBe('blk-1'); // reply inherits the root's anchor

    await cs.setResolution({ threadId: root.comment!.id, userId: 'alice', resolved: true });
    const list = await cs.list({ noteId: id, userId: 'alice' });
    expect(list!.length).toBe(2);
    expect(list!.every((c) => c.resolvedAt === FIXED)).toBe(true); // resolution mirrored across the thread
  });

  it('edit is author-only; delete tombstones the body', async () => {
    const db = await makeDb();
    const cs = createNoteCommentService(db, { now: () => FIXED });
    const id = await makeNote(db, 'alice', 'N', 'x');
    // Share the note with bob so he has access to comment.
    await db.upsertNoteShare({ id: newUUIDv7(), note_id: id, tenant_id: null, owner_id: 'alice', user_id: 'bob', role: 'collaborator', joined_at: FIXED, invited_via_token_id: null });
    const c = await cs.create({ noteId: id, userId: 'bob', body: 'bob comment' });
    expect((await cs.edit({ commentId: c.comment!.id, userId: 'alice', body: 'hijack' })).code).toBe(403); // not the author
    const edited = await cs.edit({ commentId: c.comment!.id, userId: 'bob', body: 'bob edited' });
    expect(edited.comment!.body).toBe('bob edited');
    expect(edited.comment!.editedAt).toBe(FIXED);
    await cs.remove({ commentId: c.comment!.id, userId: 'bob' });
    const after = (await cs.list({ noteId: id, userId: 'alice' }))!.find((x) => x.id === c.comment!.id)!;
    expect(after.deletedAt).toBe(FIXED);
    expect(after.body).toBe(''); // tombstoned
  });

  it('SECURITY: a stranger cannot comment on or read a note', async () => {
    const db = await makeDb();
    const cs = createNoteCommentService(db, { now: () => FIXED });
    const id = await makeNote(db, 'alice', 'Private', 'x');
    expect((await cs.create({ noteId: id, userId: 'mallory', body: 'hi' })).code).toBe(404);
    expect(await cs.list({ noteId: id, userId: 'mallory' })).toBeNull();
  });
});

describe('synced blocks — read-through transclusion', () => {
  it('mirrors a source note and reflects edits live; rejects self-sync', async () => {
    const db = await makeDb();
    const ss = createNoteSyncedService(db, { now: () => FIXED });
    const source = await makeNote(db, 'alice', 'Source', 'The shared paragraph.');
    const host = await makeNote(db, 'alice', 'Host', 'Host note.');

    expect((await ss.create({ noteId: host, userId: 'alice', sourceNoteId: host })).code).toBe(400); // self-sync
    const made = await ss.create({ noteId: host, userId: 'alice', sourceNoteId: source });
    expect(made.ok).toBe(true);

    let list = await ss.list({ noteId: host, userId: 'alice' });
    expect(list![0]!.markdown).toContain('The shared paragraph');
    expect(list![0]!.available).toBe(true);

    // Edit the SOURCE → the synced view reflects it (read-through, no propagation).
    await db.updateNote(source, 'alice', { doc_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited shared text.' }] }] }) });
    list = await ss.list({ noteId: host, userId: 'alice' });
    expect(list![0]!.markdown).toContain('Edited shared text');
  });

  it('resolves a single block by index and marks a missing source unavailable', async () => {
    const db = await makeDb();
    const ss = createNoteSyncedService(db, { now: () => FIXED });
    const source = await makeNote(db, 'alice', 'Multi', '# Heading\n\nFirst para.\n\nSecond para.');
    const host = await makeNote(db, 'alice', 'Host', 'x');
    await ss.create({ noteId: host, userId: 'alice', sourceNoteId: source, sourceBlockIndex: 0 });
    const list = await ss.list({ noteId: host, userId: 'alice' });
    expect(list![0]!.sourceBlockIndex).toBe(0);
    expect(list![0]!.markdown).toContain('Heading'); // the first block only
    expect(list![0]!.markdown).not.toContain('Second para');
  });

  it('SECURITY: cannot create a synced block in or from a note you do not own', async () => {
    const db = await makeDb();
    const ss = createNoteSyncedService(db, { now: () => FIXED });
    const aliceNote = await makeNote(db, 'alice', 'A', 'a');
    const malloryNote = await makeNote(db, 'mallory', 'M', 'm');
    expect((await ss.create({ noteId: malloryNote, userId: 'mallory', sourceNoteId: aliceNote })).code).toBe(404); // can't read alice's source
    expect((await ss.create({ noteId: aliceNote, userId: 'mallory', sourceNoteId: malloryNote })).code).toBe(404); // can't write alice's host
  });
});
