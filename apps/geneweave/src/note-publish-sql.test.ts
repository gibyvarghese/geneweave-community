// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 4 PUBLISH service against a real on-disk
 * SQLite database (artifacts + notes schema). Proves the acceptance deterministically:
 * note → redacted Markdown/HTML artifact; sensitivity gating (restricted refused,
 * confidential redacts PII, normal scrubs secrets); a public share token that verifies;
 * the agent publishes privately (never auto-public); and viewer/stranger are refused.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { resolveNoteAccess, createNoteSharing } from './note-coedit-sql.js';
import { createNotePublishService } from './note-publish-sql.js';
import { verifyShareToken } from './routes/artifacts.js';

const SECRET = 'test-jwt-secret-please-change';
function tmpDb(): string { return join(tmpdir(), `gw-notepub-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}
/** A note whose body contains a secret (API key) and PII (an email). */
async function makeNote(db: SQLiteAdapter, owner: string, sensitivity: 'normal' | 'confidential' | 'restricted', tenant: string | null = null): Promise<string> {
  const id = newUUIDv7();
  const pm = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Launch checklist' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Deploy with key sk-ABCDEF0123456789abcdef and ping alice@example.com.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Final QA pass' }] }] }] },
  ] };
  await db.createNote({ id, owner_user_id: owner, tenant_id: tenant, title: 'Launch plan', doc_json: JSON.stringify(pm), sensitivity, is_template: 0, favorite: 0 });
  return id;
}
async function owner(db: SQLiteAdapter, noteId: string, userId: string) {
  return (await resolveNoteAccess(db, noteId, userId))!;
}

describe('note publish — sensitivity gating + redaction', () => {
  it('publishes a NORMAL note as a Markdown artifact, scrubbing SECRETS (not PII)', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'normal');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice'), publishedBy: 'user' });
    expect(r.ok).toBe(true);
    expect(r.type).toBe('markdown');
    const art = await db.getArtifact!(r.artifactId!);
    expect(art!.type).toBe('markdown');
    expect(art!.data_text).toContain('Launch checklist');
    expect(art!.data_text).toContain('[REDACTED-SECRET]');     // the API key was scrubbed
    expect(art!.data_text).not.toContain('sk-ABCDEF0123456789abcdef');
    expect(art!.data_text).toContain('alice@example.com');      // PII kept at "normal" sensitivity
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    // Provenance is recorded in metadata.
    const meta = JSON.parse(art!.metadata ?? '{}') as Record<string, unknown>;
    expect(meta['source']).toBe('note');
    expect(meta['noteId']).toBe(noteId);
    expect(meta['sourceSensitivity']).toBe('normal');
  });

  it('publishes a CONFIDENTIAL note, redacting PII as well', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'confidential');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice') });
    expect(r.ok).toBe(true);
    const art = await db.getArtifact!(r.artifactId!);
    expect(art!.data_text).toContain('[REDACTED-EMAIL]');      // PII redacted for confidential
    expect(art!.data_text).not.toContain('alice@example.com');
    expect(art!.data_text).toContain('[REDACTED-SECRET]');     // secrets still redacted
  });

  it('REFUSES to publish a RESTRICTED note (403)', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'restricted');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice') });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(403);
    expect(r.error).toMatch(/restricted/);
  });

  it('emits HTML when requested', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'normal');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice'), format: 'html' });
    expect(r.ok).toBe(true);
    const art = await db.getArtifact!(r.artifactId!);
    expect(art!.type).toBe('html');
    expect(art!.data_text).toContain('<h2>');
  });
});

describe('note publish — public share link', () => {
  it('mints a verifiable share token that resolves to the published artifact', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET, publicBaseUrl: 'https://app.example.com' });
    const noteId = await makeNote(db, 'alice', 'normal');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice'), share: true });
    expect(r.ok).toBe(true);
    expect(r.shareUrl).toContain('https://app.example.com/share/artifacts/');
    const payload = verifyShareToken(r.shareToken!, SECRET);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe(r.artifactId); // the token points at the published artifact
    // A token signed with the wrong secret does NOT verify.
    expect(verifyShareToken(r.shareToken!, 'wrong-secret')).toBeNull();
  });

  it('a password-protected share token carries the password hash', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'normal');
    const r = await pub.emit({ noteId, access: await owner(db, noteId, 'alice'), share: true, password: 'hunter2' });
    const payload = verifyShareToken(r.shareToken!, SECRET);
    expect(payload!.ph).toBeTruthy(); // password hash present
  });
});

describe('note publish — agent + security', () => {
  it('the agent publishes PRIVATELY (no public link) and only what the user can access', async () => {
    const db = await makeDb();
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'normal', 'tA');

    // Owner-triggered agent publish → artifact created, but NO share link.
    const r = await pub.agentPublish({ userId: 'alice', noteId });
    expect(r.ok).toBe(true);
    expect(r.shareUrl).toBeUndefined(); // agent never auto-mints a public link
    const art = await db.getArtifact!(r.artifactId!);
    expect(art!.user_id).toBe('alice');
    expect(JSON.parse(art!.metadata ?? '{}')['publishedBy']).toBe('agent');

    // A stranger cannot publish someone else's note.
    expect((await pub.agentPublish({ userId: 'mallory', noteId })).ok).toBe(false);
  });

  it('a VIEWER cannot publish (read-only) but a COLLABORATOR can', async () => {
    const db = await makeDb();
    const sharing = createNoteSharing(db);
    const pub = createNotePublishService(db, { jwtSecret: SECRET });
    const noteId = await makeNote(db, 'alice', 'normal', 'tA');

    const viewerInvite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'viewer' }))!;
    await sharing.join(viewerInvite.token, 'bob');
    const asViewer = await pub.agentPublish({ userId: 'bob', noteId });
    expect(asViewer.ok).toBe(false);
    expect(asViewer.error).toMatch(/read-only|forbidden/);

    const collabInvite = (await sharing.createInvite({ noteId, ownerId: 'alice', tenantId: 'tA', role: 'collaborator' }))!;
    await sharing.join(collabInvite.token, 'carol');
    const asCollab = await pub.agentPublish({ userId: 'carol', noteId });
    expect(asCollab.ok).toBe(true); // collaborators may publish
  });
});
