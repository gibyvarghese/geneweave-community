// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 3 AI co-author SERVICE against a real
 * on-disk SQLite database (m100 + m101 schema), with a deterministic fake LLM so
 * it runs fast and offline. This is the backbone behind the real-LLM Playwright
 * e2e: it proves the track-changes lifecycle, the agent-as-peer convergence, AI
 * blocks + refresh, and the security gates — positive, negative, and stress.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { BlockDoc, diffBlocks } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteCoeditRepo, createNoteSharing, resolveNoteAccess } from './note-coedit-sql.js';
import { createNoteAiService, type NoteAiGenerate } from './note-ai-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-noteai-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
async function makeNote(db: SQLiteAdapter, owner: string, tenant: string | null = null): Promise<string> {
  const id = newUUIDv7();
  const pm = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Project plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'The quick brown fox.' }] },
  ] };
  await db.createNote({ id, owner_user_id: owner, tenant_id: tenant, title: 'AI note', doc_json: JSON.stringify(pm), is_template: 0, favorite: 0 });
  return id;
}

/** A deterministic stand-in for the LLM: returns content keyed off the action prompt. */
const fakeGen: NoteAiGenerate = async ({ user, system }) => {
  if (/Summarize this document/.test(user)) return '## Summary\n- Plan covers the fox.';
  if (/Passage to rewrite/.test(user)) return 'The agile auburn fox leaps.';
  if (/Generate content for/.test(user)) return 'AI-generated block about momentum.';
  if (/Regenerate content for/.test(user)) return 'Refreshed AI content with new momentum.';
  if (/Question:/.test(user)) return 'The key takeaway is focus.';
  if (/Continue it/.test(user) || /writing assistant/.test(system ?? '')) return '## Next steps\n- Ship the plan.';
  return 'AI wrote this.';
};

async function ownerAccess(db: SQLiteAdapter, noteId: string, userId: string) {
  return (await resolveNoteAccess(db, noteId, userId))!;
}

describe('note AI co-author — track-changes suggestions', () => {
  it('propose("continue") STAGES a suggestion without touching the doc; accept applies it', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');

    const proposed = await ai.propose({ noteId, access, action: 'continue' });
    expect(proposed.ok).toBe(true);
    expect(proposed.preview).toContain('Next steps');

    // The canonical doc is UNCHANGED while pending.
    const before = (await relay.getViewByNote(noteId))!.blocks.map((b) => b.text);
    expect(before.join(' ')).not.toContain('Ship the plan');
    expect((await ai.list(noteId, 'pending')).length).toBe(1);

    // Accept → the staged ops apply.
    const acc = await ai.accept(proposed.suggestionId!, 'alice', access);
    expect(acc.ok).toBe(true);
    const after = (await relay.getViewByNote(noteId))!.blocks.map((b) => b.text);
    expect(after.join(' ')).toContain('Ship the plan');
    expect((await ai.list(noteId, 'pending')).length).toBe(0);
  });

  it('reject discards the suggestion; the doc never changes', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');
    const before = (await relay.ensureDoc({ noteId, tenantId: null, ownerId: 'alice', seedPm: { type: 'doc', content: [] } })).blocks.length;

    const proposed = await ai.propose({ noteId, access, action: 'summarize' });
    const rej = await ai.reject(proposed.suggestionId!, 'alice', access);
    expect(rej.ok).toBe(true);
    const after = (await relay.getViewByNote(noteId))!.blocks.length;
    expect(after).toBe(before); // nothing applied
    expect((await db.getNoteSuggestion(proposed.suggestionId!))!.status).toBe('rejected');
  });

  it('rewrite targets a specific block and accept replaces its content', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');
    const view = await relay.ensureDoc({ noteId, tenantId: null, ownerId: 'alice', seedPm: JSON.parse((await db.getNote(noteId, 'alice'))!.doc_json) });
    const para = view.blocks.find((b) => b.text.includes('quick brown fox'))!;

    const proposed = await ai.propose({ noteId, access, action: 'rewrite', selectionBlockId: para.id!, selectionText: para.text });
    await ai.accept(proposed.suggestionId!, 'alice', access);
    const texts = (await relay.getViewByNote(noteId))!.blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('auburn fox'))).toBe(true);
    expect(texts.some((t) => t.includes('quick brown fox'))).toBe(false); // replaced
  });

  it('double-accept is rejected (idempotency guard)', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');
    const p = await ai.propose({ noteId, access, action: 'continue' });
    expect((await ai.accept(p.suggestionId!, 'alice', access)).ok).toBe(true);
    expect((await ai.accept(p.suggestionId!, 'alice', access)).ok).toBe(false); // already accepted
  });
});

describe('note AI co-author — agent as a peer (note_edit tool)', () => {
  it('agentEdit(direct) applies + CONVERGES with a concurrent human edit', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const view = await relay.ensureDoc({ noteId, tenantId: null, ownerId: 'alice', seedPm: JSON.parse((await db.getNote(noteId, 'alice'))!.doc_json) });

    // A human edits the heading concurrently…
    const human = BlockDoc.fromSnapshot('u:alice:tab', view.snapshot);
    const humanOps = diffBlocks(human, human.blocks().map((b, i) => ({ type: b.type, attrs: b.attrs, text: i === 0 ? 'Project plan (v2)' : b.text })));
    await relay.submitOps(view.docId, 'u:alice', humanOps);

    // …while the agent appends its content directly.
    const r = await ai.agentEdit({ userId: 'alice', noteId, markdown: '## Agent section\n- agent point', mode: 'direct' });
    expect(r.ok).toBe(true);
    expect((r.applied ?? 0)).toBeGreaterThan(0);

    const texts = (await relay.getViewByNote(noteId))!.blocks.map((b) => b.text);
    expect(texts).toContain('Project plan (v2)'); // human edit survived
    expect(texts.join(' ')).toContain('agent point'); // agent content present — converged
  });

  it('agentEdit(suggest) stages a suggestion instead of applying', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const noteId = await makeNote(db, 'alice');
    const r = await ai.agentEdit({ userId: 'alice', noteId, markdown: '- staged agent idea', mode: 'suggest' });
    expect(r.ok).toBe(true);
    expect(r.suggestionId).toBeTruthy();
    expect((await ai.list(noteId, 'pending')).some((s) => s.id === r.suggestionId)).toBe(true);
  });

  it('SECURITY: a viewer cannot agentEdit, and a stranger gets "not accessible"', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const sharing = createNoteSharing(db);
    const noteId = await makeNote(db, 'alice', 'tA');
    // Share as viewer to bob.
    const invite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'viewer' }))!;
    await sharing.join(invite.token, 'bob');
    const asViewer = await ai.agentEdit({ userId: 'bob', noteId, markdown: 'sneaky', mode: 'direct' });
    expect(asViewer.ok).toBe(false);
    expect(asViewer.error).toMatch(/read-only|forbidden/);
    const asStranger = await ai.agentEdit({ userId: 'mallory', noteId, markdown: 'sneaky', mode: 'direct' });
    expect(asStranger.ok).toBe(false);
  });
});

describe('note AI co-author — AI blocks (refreshFn)', () => {
  it('insertAiBlock adds a cited block; refreshAiBlock re-generates its content, preserving the prompt', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');

    const ins = await ai.insertAiBlock({ noteId, access, prompt: 'a one-line status', citation: 'note:self' });
    expect(ins.ok).toBe(true);
    expect(ins.text).toContain('momentum');

    // The block remembers its prompt + citation.
    const block = (await relay.getViewByNote(noteId))!.blocks.find((b) => b.attrs['aiPrompt'] === 'a one-line status')!;
    expect(block).toBeTruthy();
    expect(block.attrs['aiCitation']).toBe('note:self');
    const firstRefreshedAt = block.attrs['aiRefreshedAt'];

    // Refresh re-generates the content but keeps the prompt + citation.
    const refr = await ai.refreshAiBlock({ noteId, access, blockId: block.id! });
    expect(refr.ok).toBe(true);
    const after = (await relay.getViewByNote(noteId))!.blocks.find((b) => b.attrs['aiPrompt'] === 'a one-line status')!;
    expect(after.text).toContain('Refreshed AI content');
    expect(after.attrs['aiCitation']).toBe('note:self'); // citation preserved
    expect(after.attrs['aiRefreshedAt']).not.toBe(firstRefreshedAt); // bumped
  });

  it('refreshAiBlock refuses a non-AI block', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');
    const view = await relay.ensureDoc({ noteId, tenantId: null, ownerId: 'alice', seedPm: JSON.parse((await db.getNote(noteId, 'alice'))!.doc_json) });
    const plain = view.blocks[0]!;
    const r = await ai.refreshAiBlock({ noteId, access, blockId: plain.id! });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not an AI block/);
  });
});

describe('note AI co-author — stress', () => {
  it('many interleaved suggestions all stage under distinct sites and apply without collision', async () => {
    const db = await makeDb();
    const ai = createNoteAiService(db, fakeGen);
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice');
    const access = await ownerAccess(db, noteId, 'alice');

    // Stage 8 suggestions, then accept them all.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await ai.propose({ noteId, access, action: i % 2 === 0 ? 'continue' : 'ask', instruction: `idea ${i}` });
      expect(p.ok).toBe(true); ids.push(p.suggestionId!);
    }
    for (const id of ids) expect((await ai.accept(id, 'alice', access)).ok).toBe(true);
    // The doc grew and is internally consistent (re-render round-trips through the CRDT).
    const view = await relay.getViewByNote(noteId);
    expect(view!.blocks.length).toBeGreaterThan(2);
  });
});
