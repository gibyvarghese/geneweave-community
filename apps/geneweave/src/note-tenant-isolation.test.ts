// SPDX-License-Identifier: MIT
/**
 * Phase 0 security — TENANT ISOLATION for weaveNotes search/RAG/graph.
 *
 * --- For someone new to this ---
 * A "tenant" is a customer organisation. Two different organisations must NEVER see each other's
 * notes — not in search, not in "related notes", not in the AI's workspace answers. weaveNotes
 * stores every note embedding with both a `user_id` AND a `tenant_id`. Before this fix the search
 * queries filtered by `user_id` only, so if the same account id ever existed under two tenants (or
 * a user moved between tenants), one tenant's notes could surface for the other.
 *
 * These tests prove the fix the HARD way: we put two notes under the SAME user id `alice` but in
 * two DIFFERENT tenants ('acme' and 'globex'). If isolation worked only by user, both would leak.
 * We assert the tenant gate (`tenant_id IS ?`, null-safe) is what keeps them apart — at the DB
 * choke-point AND through the graph + related-notes services.
 *
 * Deterministic fake embedder (bag-of-keywords) → fast, offline, no real LLM needed.
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

function tmpDb(): string { return join(tmpdir(), `gw-tenant-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
function paragraph(text: string) { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }; }
// Create a note owned by `owner` inside `tenant` (tenant may be null for a "no tenant" account).
async function makeNote(db: SQLiteAdapter, owner: string, tenant: string | null, title: string, text: string): Promise<string> {
  const id = newUUIDv7();
  await db.createNote({ id, owner_user_id: owner, tenant_id: tenant, title, doc_json: JSON.stringify(paragraph(text)), is_template: 0, favorite: 0 });
  return id;
}
const access = (ownerId: string, tenantId: string | null): NoteAccess => ({ noteId: '', ownerId, tenantId, role: 'owner' });

// Deterministic embedder: a bag-of-keywords vector so similar topics score high.
const VOCAB = ['quantum', 'qubit', 'majorana', 'topolog', 'merger', 'revenue', 'finance', 'roadmap'];
function embedText(t: string): number[] { const low = t.toLowerCase(); return VOCAB.map((w) => low.split(w).length - 1); }
const fakeEmbModel = {
  info: { id: 'fake-embed', provider: 'test', name: 'fake', dimensions: VOCAB.length },
  capabilities: () => ['embedding'],
  embed: async (_ctx: unknown, req: { input: readonly string[] }) => ({ embeddings: req.input.map(embedText), model: 'fake', usage: { totalTokens: 0 } }),
};
const fakeGen: NoteAiGenerate = async () => JSON.stringify({ entities: [], relations: [] });

beforeEach(() => setActiveGuardrailEmbeddingModel(fakeEmbModel as never));
afterEach(() => setActiveGuardrailEmbeddingModel(undefined));

describe('tenant isolation — embedding choke-point (db.listUserNoteEmbeddings)', () => {
  it('same user id in two tenants: each tenant only sees its OWN embeddings', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    // SAME user 'alice', DIFFERENT tenants, SIMILAR topic (so cosine would match if not gated).
    const acme = await makeNote(db, 'alice', 'acme', 'Acme Quantum', 'quantum qubit majorana topolog roadmap');
    const globex = await makeNote(db, 'alice', 'globex', 'Globex Quantum', 'quantum qubit majorana topolog finance');
    await svc.indexNote({ noteId: acme, access: access('alice', 'acme') });
    await svc.indexNote({ noteId: globex, access: access('alice', 'globex') });

    // The data is genuinely co-mingled under one user id: the UNFILTERED read returns BOTH.
    const unfiltered = await db.listUserNoteEmbeddings('alice');
    expect(unfiltered.map((r) => r.note_id).sort()).toEqual([acme, globex].sort());

    // The tenant-gated reads return ONLY that tenant's note — the gate is what isolates.
    const acmeOnly = await db.listUserNoteEmbeddings('alice', 'acme');
    expect(acmeOnly.map((r) => r.note_id)).toEqual([acme]);
    const globexOnly = await db.listUserNoteEmbeddings('alice', 'globex');
    expect(globexOnly.map((r) => r.note_id)).toEqual([globex]);
  });

  it('null tenant is isolated from a named tenant (null-safe IS ?)', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const personal = await makeNote(db, 'bob', null, 'Personal', 'quantum qubit majorana');
    const corp = await makeNote(db, 'bob', 'acme', 'Corp', 'quantum qubit majorana');
    await svc.indexNote({ noteId: personal, access: access('bob', null) });
    await svc.indexNote({ noteId: corp, access: access('bob', 'acme') });

    expect((await db.listUserNoteEmbeddings('bob', null)).map((r) => r.note_id)).toEqual([personal]);
    expect((await db.listUserNoteEmbeddings('bob', 'acme')).map((r) => r.note_id)).toEqual([corp]);
    // getNoteEmbedding is gated too: asking for the corp note as the null tenant returns nothing.
    expect(await db.getNoteEmbedding(corp, null)).toBeNull();
    expect((await db.getNoteEmbedding(corp, 'acme'))?.note_id).toBe(corp);
  });
});

describe('tenant isolation — graph services never cross tenants', () => {
  it('relatedNotes(acme) never returns the globex note (and vice-versa)', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const acme = await makeNote(db, 'alice', 'acme', 'Acme Quantum', 'quantum qubit majorana topolog');
    const globex = await makeNote(db, 'alice', 'globex', 'Globex Quantum', 'quantum qubit majorana topolog');
    await svc.indexNote({ noteId: acme, access: access('alice', 'acme') });
    await svc.indexNote({ noteId: globex, access: access('alice', 'globex') });

    const relatedToAcme = await svc.relatedNotes(acme, access('alice', 'acme'));
    expect(relatedToAcme.map((r) => r.noteId)).not.toContain(globex);
    const relatedToGlobex = await svc.relatedNotes(globex, access('alice', 'globex'));
    expect(relatedToGlobex.map((r) => r.noteId)).not.toContain(acme);
  });

  it('searchNotes scoped to a tenant excludes the other tenant', async () => {
    const db = await makeDb();
    const svc = createNoteGraphService(db, { generate: fakeGen });
    const acme = await makeNote(db, 'alice', 'acme', 'Acme Quantum', 'quantum qubit majorana');
    const globex = await makeNote(db, 'alice', 'globex', 'Globex Quantum', 'quantum qubit majorana');
    await svc.indexNote({ noteId: acme, access: access('alice', 'acme') });
    await svc.indexNote({ noteId: globex, access: access('alice', 'globex') });

    const acmeHits = await svc.searchNotes({ userId: 'alice', tenantId: 'acme' }, 'quantum majorana');
    expect(acmeHits.map((r) => r.noteId)).toEqual([acme]); // ONLY acme — globex is invisible
    const globexHits = await svc.searchNotes({ userId: 'alice', tenantId: 'globex' }, 'quantum majorana');
    expect(globexHits.map((r) => r.noteId)).toEqual([globex]);
  });
});
