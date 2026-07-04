/**
 * Tests — geneWeave's CRDT co-editing TRUSTED RELAY (Collaboration Phase 7).
 * Proves the server-authoritative path: two human sites + the agent peer all
 * converge through the relay; offline reconcile via opsSince; and the relay
 * rejects forged ops.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RgaDoc } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createCoeditRepo, userSiteId } from './coedit-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-coedit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'owner', email: 'o@x.dev', name: 'O', passwordHash: 'x' });
  await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
  return db;
}

describe('coedit relay — server-authoritative co-editing', () => {
  it('ensureDoc is idempotent per run', async () => {
    const db = await freshDb();
    const repo = createCoeditRepo(db);
    const a = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    const b = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    expect(b.docId).toBe(a.docId); // same doc
  });

  it('two humans + the agent co-edit and CONVERGE through the relay', async () => {
    const db = await freshDb();
    const repo = createCoeditRepo(db);
    const { docId } = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });

    // Alice (a local replica) types "Hello" and submits her ops.
    const aliceSite = userSiteId('alice');
    const alice = new RgaDoc(aliceSite);
    const aliceOps = alice.localInsertText(0, 'Hello');
    const r1 = await repo.submitOps(docId, aliceSite, aliceOps);
    expect(r1.ok).toBe(true);

    // The agent streams its output as a peer (idempotent suffix append).
    const ag = await repo.agentAppend(docId, 'r1', 'XYZ');
    expect(ag!.applied.length).toBe(3);
    // Calling again with the SAME text inserts nothing (idempotent).
    const ag2 = await repo.agentAppend(docId, 'r1', 'XYZ');
    expect(ag2!.applied.length).toBe(0);

    // Bob (another replica, starting empty) reconciles via opsSince → same text.
    const bob = new RgaDoc(userSiteId('bob'));
    const missing = await repo.opsSince(docId, bob.stateVector());
    bob.applyMany(missing);
    const serverView = await repo.getView(docId);
    expect(bob.text()).toBe(serverView!.text);
    expect(serverView!.text).toContain('Hello');
    expect(serverView!.text).toContain('XYZ');
  });

  it('offline reconcile: a peer that edited offline merges via opsSince', async () => {
    const db = await freshDb();
    const repo = createCoeditRepo(db);
    const { docId } = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    const site = userSiteId('alice');
    const a = new RgaDoc(site);
    await repo.submitOps(docId, site, a.localInsertText(0, 'base'));

    // A second device for the same user goes offline and edits.
    const offline = new RgaDoc(userSiteId('alice2'));
    offline.applyMany(await repo.opsSince(docId, offline.stateVector())); // sync to "base"
    const offlineOps = offline.localInsertText(4, '!');                   // edit offline
    // Reconnect: push the offline ops; pull anything new.
    await repo.submitOps(docId, userSiteId('alice2'), offlineOps);
    const view = await repo.getView(docId);
    expect(view!.text).toBe('base!');
  });

  it('SECURITY: rejects ops forging another author site', async () => {
    const db = await freshDb();
    const repo = createCoeditRepo(db);
    const { docId } = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    // alice tries to submit an op authored as "bob".
    const forged = [{ type: 'ins', id: { counter: 1, siteId: userSiteId('bob') }, originId: null, value: 'x' }];
    const res = await repo.submitOps(docId, userSiteId('alice'), forged);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/forgery|another site/i);
  });

  it('SECURITY: rejects a flood / malformed batch', async () => {
    const db = await freshDb();
    const repo = createCoeditRepo(db);
    const { docId } = await repo.ensureDoc({ runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    expect((await repo.submitOps(docId, userSiteId('a'), 'not-an-array')).ok).toBe(false);
    expect((await repo.submitOps(docId, userSiteId('a'), [])).ok).toBe(false);
  });
});
