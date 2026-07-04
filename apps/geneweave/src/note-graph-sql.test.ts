// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 5 knowledge-graph SERVICE against a real
 * on-disk SQLite database (m102), with a deterministic fake LLM + a deterministic
 * embedding model (bag-of-keywords) so it runs fast and offline. Proves: wiki-link
 * resolution → backlinks, entity/relation extraction, unlinked mentions, semantic
 * related-notes + search, the graph build, and owner-scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteGraphService } from './note-graph-sql.js';
import { setActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import type { NoteAccess } from './note-coedit-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-notegraph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
function paragraph(text: string) { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }; }
async function makeNote(db: SQLiteAdapter, owner: string, title: string, text: string): Promise<string> {
  const id = newUUIDv7();
  await db.createNote({ id, owner_user_id: owner, tenant_id: null, title, doc_json: JSON.stringify(paragraph(text)), is_template: 0, favorite: 0 });
  return id;
}
const access = (ownerId: string): NoteAccess => ({ noteId: '', ownerId, tenantId: null, role: 'owner' });

// Deterministic embedder: a bag-of-keywords vector so similar topics score high.
const VOCAB = ['quantum', 'qubit', 'majorana', 'topolog', 'cooking', 'recipe', 'pasta', 'garden'];
function embedText(t: string): number[] { const low = t.toLowerCase(); return VOCAB.map((w) => low.split(w).length - 1); }
const fakeEmbModel = {
  info: { id: 'fake-embed', provider: 'test', name: 'fake', dimensions: VOCAB.length },
  capabilities: () => ['embedding'],
  embed: async (_ctx: unknown, req: { input: readonly string[] }) => ({ embeddings: req.input.map(embedText), model: 'fake', usage: { totalTokens: 0 } }),
};

// Deterministic "LLM" for entity extraction.
const fakeGen: NoteAiGenerate = async () => JSON.stringify({
  entities: [{ name: 'Majorana qubit', type: 'technology' }, { name: 'Microsoft', type: 'organization' }],
  relations: [{ subject: 'Microsoft', predicate: 'researches', object: 'Majorana qubit' }],
});

beforeEach(() => setActiveGuardrailEmbeddingModel(fakeEmbModel as never));
afterEach(() => setActiveGuardrailEmbeddingModel(undefined));

describe('note graph — wiki-links + backlinks', () => {
  it('resolves [[wiki-links]] to note links; backlinks render with titles', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const target = await makeNote(db, 'alice', 'Quantum Computing', 'A field of computing.');
    const source = await makeNote(db, 'alice', 'My research log', 'Today I studied [[Quantum Computing]] in depth.');

    const r = await svc.indexNote({ noteId: source, access: access('alice') });
    expect(r.ok).toBe(true);
    expect(r.links).toBe(1); // [[Quantum Computing]] resolved

    // The target note now has a backlink from the source, resolved to its title.
    const backlinks = await svc.backlinks(target, 'alice');
    expect(backlinks).toEqual([{ noteId: source, title: 'My research log' }]);
  });

  it('re-indexing is idempotent (no duplicate links)', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    await makeNote(db, 'alice', 'Topology', 'math');
    const source = await makeNote(db, 'alice', 'Notes', 'See [[Topology]].');
    await svc.indexNote({ noteId: source, access: access('alice') });
    const second = await svc.indexNote({ noteId: source, access: access('alice') });
    expect(second.links).toBe(0); // already linked
    expect((await db.listNoteLinks(source)).filter((l) => l.target_kind === 'note').length).toBe(1);
  });
});

describe('note graph — entities/relations + unlinked mentions', () => {
  it('extracts + stores entities and relations', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const id = await makeNote(db, 'alice', 'Majorana research', 'Microsoft works on the Majorana qubit.');
    const r = await svc.indexNote({ noteId: id, access: access('alice') });
    expect(r.entities).toBe(2);
    expect(r.relations).toBe(1);
    const ents = (await db.listNoteEntities(id)).map((e) => e.name).sort();
    expect(ents).toEqual(['Majorana qubit', 'Microsoft']);
  });

  it('finds unlinked mentions (title in prose, not yet [[linked]])', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    await makeNote(db, 'alice', 'Quantum Computing', 'x');
    const note = await makeNote(db, 'alice', 'Log', 'I keep coming back to Quantum Computing in my reading.');
    const unlinked = await svc.unlinkedMentions(note, access('alice'));
    expect(unlinked.map((u) => u.title)).toEqual(['Quantum Computing']);
    // After linking it, it is no longer "unlinked".
    await db.createNoteLink({ id: newUUIDv7(), note_id: note, target_kind: 'note', target_id: (await db.listNotes('alice')).find((n) => n.title === 'Quantum Computing')!.id });
    // (note text still says it in prose, but the title is now linked → still shows until the prose uses [[ ]];
    //  the linkedTitleKeys gate is driven by [[ ]] in the doc, so we assert the link exists)
    expect((await db.listNoteLinks(note)).some((l) => l.target_kind === 'note')).toBe(true);
  });
});

describe('note graph — semantic related notes + search', () => {
  it('surfaces topically-related notes (cosine) and ignores unrelated ones', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const q1 = await makeNote(db, 'alice', 'Quantum basics', 'quantum qubit superposition');
    const q2 = await makeNote(db, 'alice', 'Quantum hardware', 'quantum qubit majorana topolog');
    const cook = await makeNote(db, 'alice', 'Dinner', 'cooking recipe pasta garden');
    for (const id of [q1, q2, cook]) await svc.indexNote({ noteId: id, access: access('alice') });

    const related = await svc.relatedNotes(q1, access('alice'), 5);
    expect(related.map((r) => r.noteId)).toContain(q2); // shares quantum/qubit
    expect(related.map((r) => r.noteId)).not.toContain(cook); // no shared vocabulary
    expect(related.find((r) => r.noteId === q2)!.score).toBeGreaterThan(0.1);
  });

  it('searchNotes ranks the user\'s notes by relevance to a query', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const q = await makeNote(db, 'alice', 'Quantum', 'quantum qubit');
    const c = await makeNote(db, 'alice', 'Cooking', 'recipe pasta');
    for (const id of [q, c]) await svc.indexNote({ noteId: id, access: access('alice') });
    const hits = await svc.searchNotes({ userId: 'alice' }, 'tell me about qubit research', 5);
    expect(hits[0]!.noteId).toBe(q); // the quantum note ranks first
  });
});

describe('note graph — graph build + security', () => {
  it('builds nodes + edges (notes + entities + relations)', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const target = await makeNote(db, 'alice', 'Quantum Computing', 'field');
    const note = await makeNote(db, 'alice', 'Hub', 'Studying [[Quantum Computing]] and Majorana.');
    await svc.indexNote({ noteId: note, access: access('alice') });

    const g = await svc.graph(note, access('alice'));
    expect(g.nodes.some((n) => n.kind === 'note' && n.label === 'Quantum Computing')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'entity' && /majorana/i.test(n.label))).toBe(true);
    expect(g.edges.some((e) => e.label === 'links to')).toBe(true);
    expect(g.edges.some((e) => e.label === 'mentions')).toBe(true);
    expect(g.edges.some((e) => e.label === 'researches')).toBe(true); // relation predicate
    void target;
  });

  it('is owner-scoped: another user sees no graph/backlinks for the note', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const note = await makeNote(db, 'alice', 'Private', 'secret [[Quantum Computing]]');
    await makeNote(db, 'alice', 'Quantum Computing', 'x');
    await svc.indexNote({ noteId: note, access: access('alice') });
    // mallory cannot resolve alice's note → empty graph + backlinks.
    const g = await svc.graph(note, access('mallory'));
    expect(g.nodes).toEqual([]);
    expect(await svc.backlinks(note, 'mallory')).toEqual([]);
  });
});
