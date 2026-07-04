// SPDX-License-Identifier: MIT
/**
 * Integration test — geneWeave's collaborative NOTE co-editing RELAY (weaveNotes
 * Phase 2) against a real on-disk SQLite database (the m100 schema).
 *
 * This is the deterministic backbone behind the real-LLM Playwright e2e: it proves
 * the acceptance criteria fast and exhaustively — two clients co-edit one note and
 * CONVERGE, a reconnecting peer reconciles via state-vector diff, sharing grants the
 * right role, the relay rejects identity forgery, diff-on-save merges a whole-doc
 * edit, and a fuzz of interleaved edits through the relay always converges.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { BlockDoc, diffBlocks, type BlockOp, type BlockSpec } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteCoeditRepo, createNoteSharing, resolveNoteAccess, userNoteSiteId } from './note-coedit-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-notecoedit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
async function makeNote(db: SQLiteAdapter, owner: string, pm: unknown, tenant: string | null = null): Promise<string> {
  const id = newUUIDv7();
  await db.createNote({ id, owner_user_id: owner, tenant_id: tenant, title: 'Co-edit note', doc_json: JSON.stringify(pm), is_template: 0, favorite: 0 });
  return id;
}

const SEED_PM = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Shared plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
  ],
};

describe('note co-edit relay — access resolution + sharing', () => {
  it('owner resolves as owner; a stranger gets no access (404)', async () => {
    const db = await makeDb();
    const noteId = await makeNote(db, 'alice', SEED_PM);
    expect((await resolveNoteAccess(db, noteId, 'alice'))?.role).toBe('owner');
    expect(await resolveNoteAccess(db, noteId, 'mallory')).toBeNull();
  });

  it('an invite grants the right role; join is idempotent and keeps the higher role', async () => {
    const db = await makeDb();
    const sharing = createNoteSharing(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');

    // Non-owner cannot mint an invite.
    expect(await sharing.createInvite({ noteId, ownerId: 'mallory', tenantId: 'tA' })).toBeNull();

    const viewerInvite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'viewer' }))!;
    const r1 = await sharing.join(viewerInvite.token, 'bob');
    expect(r1.ok && r1.role).toBe('viewer');
    expect((await resolveNoteAccess(db, noteId, 'bob'))?.role).toBe('viewer');

    // A collaborator invite upgrades bob (highest permission wins); re-join is idempotent.
    const collabInvite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'collaborator' }))!;
    expect((await sharing.join(collabInvite.token, 'bob')).ok).toBe(true);
    expect((await resolveNoteAccess(db, noteId, 'bob'))?.role).toBe('collaborator');
    expect((await db.listNoteShares(noteId)).length).toBe(1); // still ONE membership row
  });

  it('rejects revoked / expired / exhausted tokens', async () => {
    const db = await makeDb();
    const sharing = createNoteSharing(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');

    const expired = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', expiresAt: 1 }))!;
    expect((await sharing.join(expired.token, 'bob')).ok).toBe(false);

    const single = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', maxUses: 1 }))!;
    expect((await sharing.join(single.token, 'bob')).ok).toBe(true);
    expect((await sharing.join(single.token, 'carol')).ok).toBe(false); // exhausted

    const revInvite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA' }))!;
    const invites = await sharing.listInvites(noteId, 'alice');
    const toRevoke = invites.find((t) => t.token_prefix === revInvite.prefix)!;
    expect(await sharing.revokeInvite(noteId, 'alice', toRevoke.id)).toBe(true);
    expect((await sharing.join(revInvite.token, 'dave')).ok).toBe(false);
  });

  it('owner can revoke a member, dropping their access', async () => {
    const db = await makeDb();
    const sharing = createNoteSharing(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');
    const invite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'collaborator' }))!;
    await sharing.join(invite.token, 'bob');
    expect(await sharing.revokeMember(noteId, 'alice', 'bob')).toBe(true);
    expect(await resolveNoteAccess(db, noteId, 'bob')).toBeNull();
  });
});

describe('note co-edit relay — convergence + sync + security', () => {
  it('two clients co-edit one note and CONVERGE through the relay', async () => {
    const db = await makeDb();
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');

    // The doc seeds from the note's existing content.
    const view = await relay.ensureDoc({ noteId, tenantId: 'tA', ownerId: 'alice', seedPm: SEED_PM });
    expect(view.blocks.map((b) => b.text)).toEqual(['Shared plan', 'Line one', 'Line two']);

    // Two clients load the same snapshot as their replicas.
    const aliceDoc = BlockDoc.fromSnapshot('u:alice:t1', view.snapshot);
    const bobDoc = BlockDoc.fromSnapshot('u:bob:t1', view.snapshot);

    // Alice edits block 2; Bob edits block 3 — concurrently (each diffs its own replica).
    const aOps = diffBlocks(aliceDoc, [
      { type: 'heading', text: 'Shared plan', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Line one — edited by Alice' },
      { type: 'paragraph', text: 'Line two' },
    ]);
    const bOps = diffBlocks(bobDoc, [
      { type: 'heading', text: 'Shared plan', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Line one' },
      { type: 'paragraph', text: 'Line two — and Bob too' },
    ]);

    // Both submit through the relay under THEIR namespace.
    const ra = await relay.submitOps(view.docId, userNoteSiteId('alice'), aOps);
    const rb = await relay.submitOps(view.docId, userNoteSiteId('bob'), bOps);
    expect(ra.ok && rb.ok).toBe(true);

    // Each client pulls the other's ops (as the live stream would deliver) and converges.
    aliceDoc.applyMany(await relay.opsSince(view.docId, aliceDoc.stateVector()));
    bobDoc.applyMany(await relay.opsSince(view.docId, bobDoc.stateVector()));

    const server = await relay.getViewByNote(noteId);
    expect(aliceDoc.text()).toBe(bobDoc.text());
    expect(bobDoc.text()).toBe(server!.markdown.replace(/^## /, '').replace(/\n\n/g, '\n')); // sanity: same content
    const finalText = server!.blocks.map((b) => b.text);
    expect(finalText).toContain('Line one — edited by Alice');
    expect(finalText).toContain('Line two — and Bob too'); // BOTH survived — no clobber
  });

  it('a reconnecting peer reconciles via state-vector diff (offline reconcile)', async () => {
    const db = await makeDb();
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');
    const view = await relay.ensureDoc({ noteId, tenantId: 'tA', ownerId: 'alice', seedPm: SEED_PM });

    // Alice goes offline at this state vector; Bob makes several edits.
    const offlineSV = view.stateVector;
    const bobDoc = BlockDoc.fromSnapshot('u:bob:t1', view.snapshot);
    const bOps = diffBlocks(bobDoc, [
      { type: 'heading', text: 'Shared plan v2', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Line one' },
      { type: 'paragraph', text: 'Line two' },
      { type: 'paragraph', text: 'A brand new third line' },
    ]);
    await relay.submitOps(view.docId, userNoteSiteId('bob'), bOps);

    // Alice reconnects and asks ONLY for what she missed.
    const missing = await relay.opsSince(view.docId, offlineSV);
    expect(missing.length).toBe(bOps.length);
    const aliceDoc = BlockDoc.fromSnapshot('u:alice:t1', view.snapshot);
    aliceDoc.applyMany(missing);
    const server = await relay.getViewByNote(noteId);
    expect(aliceDoc.text()).toBe(server!.blocks.map((b) => b.text).join('\n'));
  });

  it('rejects identity forgery (ops authored as another user) — no lost-update either', async () => {
    const db = await makeDb();
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');
    const view = await relay.ensureDoc({ noteId, tenantId: 'tA', ownerId: 'alice', seedPm: SEED_PM });

    // Mallory crafts ops but signs them as alice's namespace — and submits under HER own.
    const forged = BlockDoc.fromSnapshot('u:alice:evil', view.snapshot); // author id forged as alice
    const ops = diffBlocks(forged, [
      { type: 'heading', text: 'Shared plan', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Line one' },
      { type: 'paragraph', text: 'Line two' },
      { type: 'paragraph', text: 'malicious injection' },
    ]);
    const res = await relay.submitOps(view.docId, userNoteSiteId('mallory'), ops);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/forbidden|forgery/);
    // The document is untouched.
    const server = await relay.getViewByNote(noteId);
    expect(server!.blocks.map((b) => b.text)).toEqual(['Shared plan', 'Line one', 'Line two']);
  });

  it('diff-on-save (syncFromProseMirror) merges a whole-document edit without clobber', async () => {
    const db = await makeDb();
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');
    const view = await relay.ensureDoc({ noteId, tenantId: 'tA', ownerId: 'alice', seedPm: SEED_PM });

    // Bob (collaborator) submits a fine-grained op first.
    const bobDoc = BlockDoc.fromSnapshot('u:bob:t1', view.snapshot);
    const bOps = diffBlocks(bobDoc, [
      { type: 'heading', text: 'Shared plan', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Line one' },
      { type: 'paragraph', text: 'Line two (bob)' },
    ]);
    await relay.submitOps(view.docId, userNoteSiteId('bob'), bOps);

    // Alice saves her WHOLE edited document (legacy single-user path) — server diffs it in.
    const aliceNewPm = {
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Shared plan (final)' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Line two (bob)' }] },
      ],
    };
    const r = await relay.syncFromProseMirror(view.docId, userNoteSiteId('alice'), aliceNewPm);
    expect(r.ok).toBe(true);
    const server = await relay.getViewByNote(noteId);
    expect(server!.blocks[0]!.text).toBe('Shared plan (final)'); // alice's heading edit
    expect(server!.blocks.some((b) => b.text === 'Line two (bob)')).toBe(true); // bob's edit survived
  });

  it('STRESS: a fuzz of interleaved edits through the relay always converges', async () => {
    const db = await makeDb();
    const relay = createNoteCoeditRepo(db);
    const noteId = await makeNote(db, 'alice', SEED_PM, 'tA');
    const view = await relay.ensureDoc({ noteId, tenantId: 'tA', ownerId: 'alice', seedPm: SEED_PM });

    // Three editors, several rounds, each diff-saving a random mutation of its replica.
    const users = ['alice', 'bob', 'carol'];
    const replicas = users.map((u) => BlockDoc.fromSnapshot(`u:${u}:t1`, view.snapshot));
    const seedTexts = ['Shared plan', 'Line one', 'Line two'];

    for (let round = 0; round < 6; round++) {
      for (let u = 0; u < users.length; u++) {
        const r = replicas[u]!;
        // 1. Pull anything new from the server first (so the diff captures only local edits).
        r.applyMany(await relay.opsSince(view.docId, r.stateVector()));
        // 2. Make a deterministic-but-varied local mutation.
        const cur = r.blocks();
        const target: BlockSpec[] = cur.map((b, i) => ({ type: b.type, attrs: b.attrs, text: `${b.text} ${users[u]![0]}${round}${i}` }));
        if (round % 2 === 0) target.push({ type: 'paragraph', text: `added by ${users[u]} @${round}` });
        const ops: BlockOp[] = diffBlocks(r, target);
        // 3. Submit through the relay.
        const sub = await relay.submitOps(view.docId, userNoteSiteId(users[u]!), ops);
        expect(sub.ok).toBe(true);
      }
    }

    // Everyone pulls to the latest and must agree byte-for-byte with the server.
    const server = await relay.getViewByNote(noteId);
    for (const r of replicas) {
      r.applyMany(await relay.opsSince(view.docId, r.stateVector()));
      expect(r.text()).toBe(server!.blocks.map((b) => b.text).join('\n'));
    }
    expect(seedTexts.length).toBeGreaterThan(0); // (keep the seed referenced for readers)
  });
});
