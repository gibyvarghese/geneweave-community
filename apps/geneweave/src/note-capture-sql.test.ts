// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 7 CAPTURE service against a real on-disk
 * SQLite database. Proves the four capture paths land structured notes with provenance:
 *   - captureRun:   a chat run's text.delta events → a note (+ a note_link back to the run)
 *   - captureWeb:   page HTML → readable note (with the source URL); SSRF-guarded
 *   - captureEmail: structured fields + a raw RFC822 message → a note
 *   - jot:          find-or-create today's "Daily Jots — <date>" note and append
 * Plus negative + security cases: SSRF rejection, owner-scoping (no cross-user run capture),
 * empty input rejection.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteCaptureService, isSafePublicUrl } from './note-capture-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-notecap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); return db;
}
async function seedRun(db: SQLiteAdapter, owner: string, deltas: string[], metadata?: Record<string, unknown>): Promise<string> {
  const runId = newUUIDv7();
  await db.createUserRun({ id: runId, user_id: owner, status: 'completed', ...(metadata ? { metadata: JSON.stringify(metadata) } : {}) });
  let seq = 0;
  for (const delta of deltas) {
    await db.appendUserRunEvent({ id: newUUIDv7(), run_id: runId, sequence: seq++, kind: 'text.delta', payload: JSON.stringify({ delta }) });
  }
  return runId;
}

// A self-contained, deterministic clock so the daily-note title is stable.
const FIXED = Date.UTC(2026, 5, 27, 14, 30, 0); // 2026-06-27 14:30 UTC
const fixedNow = () => FIXED;

describe('note capture — run → note', () => {
  it('captures a run output as a structured note and links it back to the run', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const runId = await seedRun(db, 'alice', ['# Mitochondria\n\n', 'The powerhouse ', 'of the cell.']);
    const r = await svc.captureRun({ runId, userId: 'alice', tenantId: null });
    expect(r.ok).toBe(true);
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note).not.toBeNull();
    expect(note!.doc_json).toContain('powerhouse');
    // Provenance: a note_link rows back to the source run.
    const links = await db.listNoteLinks(r.noteId!);
    expect(links.some((l) => l.target_kind === 'run' && l.target_id === runId)).toBe(true);
  });

  it('prefers a metadata title when present', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const runId = await seedRun(db, 'alice', ['some answer body'], { title: 'My Research Question' });
    const r = await svc.captureRun({ runId, userId: 'alice', tenantId: null });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('My Research Question');
  });

  it('SECURITY: another user cannot capture a run they do not own', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const runId = await seedRun(db, 'alice', ['secret output']);
    const r = await svc.captureRun({ runId, userId: 'mallory', tenantId: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(404); // never leaks that the run exists
  });
});

describe('note capture — web clip', () => {
  const HTML = '<html><head><title>A Great Article</title></head><body><article><h1>A Great Article</h1><p>This is the first substantial paragraph of the article body with enough words to be extracted as readable content.</p><p>And a second paragraph for good measure.</p></article></body></html>';

  it('clips supplied HTML into a readable note with a source link', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const r = await svc.captureWeb({ url: 'https://example.com/article', userId: 'alice', tenantId: null, html: HTML });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('A Great Article');
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note!.doc_json).toContain('substantial paragraph');
    expect(note!.doc_json).toContain('example.com/article'); // provenance source link
  });

  it('SECURITY: rejects SSRF targets (localhost, private, link-local, non-http)', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    for (const url of ['http://localhost/admin', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'file:///etc/passwd', 'ftp://example.com/']) {
      const r = await svc.captureWeb({ url, userId: 'alice', tenantId: null, html: HTML });
      expect(r.ok).toBe(false);
      expect(r.code).toBe(400);
    }
  });

  it('isSafePublicUrl accepts public http(s) and rejects unsafe hosts', () => {
    expect(isSafePublicUrl('https://example.com/a')).toBe(true);
    expect(isSafePublicUrl('http://news.ycombinator.com')).toBe(true);
    expect(isSafePublicUrl('http://localhost')).toBe(false);
    expect(isSafePublicUrl('http://10.1.2.3')).toBe(false);
    expect(isSafePublicUrl('http://169.254.169.254')).toBe(false);
    expect(isSafePublicUrl('not a url')).toBe(false);
  });
});

describe('note capture — email → note', () => {
  it('captures structured email fields', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const r = await svc.captureEmail({ email: { from: 'boss@corp.com', subject: 'Q3 plan', body: '<p>Ship the <b>feature</b> by Friday.</p>' }, userId: 'alice', tenantId: null });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Q3 plan');
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note!.doc_json).toContain('Ship the');
    expect(note!.doc_json).toContain('boss@corp.com'); // sender recorded as provenance
  });

  it('captures a raw RFC822 message', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const raw = 'From: Carol <carol@example.com>\nSubject: Project update\nDate: Mon, 27 Jun 2026\n\nThe milestone is done.';
    const r = await svc.captureEmail({ email: raw, userId: 'alice', tenantId: null });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Project update');
    const note = await db.getNote(r.noteId!, 'alice');
    expect(note!.doc_json).toContain('milestone is done');
  });
});

describe('note capture — daily jots inbox', () => {
  it('creates today\'s daily note on the first jot, then appends to it', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const first = await svc.jot({ text: 'Idea: a capture inbox', userId: 'alice', tenantId: null });
    expect(first.ok).toBe(true);
    expect(first.title).toBe('Daily Jots — 2026-06-27');
    const second = await svc.jot({ text: 'Follow-up thought', userId: 'alice', tenantId: null });
    expect(second.ok).toBe(true);
    // Both jots land in the SAME daily note.
    expect(second.noteId).toBe(first.noteId);
    const note = await db.getNote(first.noteId!, 'alice');
    expect(note!.doc_json).toContain('capture inbox');
    expect(note!.doc_json).toContain('Follow-up thought');
    // Only one daily note exists for the day.
    const dailies = (await db.listNotes('alice', { search: 'Daily Jots' })).filter((n) => n.title === 'Daily Jots — 2026-06-27');
    expect(dailies.length).toBe(1);
  });

  it('rejects an empty jot', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const r = await svc.jot({ text: '   ', userId: 'alice', tenantId: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
  });

  it('jot notes are owner-scoped (another user gets their own inbox)', async () => {
    const db = await makeDb();
    const svc = createNoteCaptureService(db, { now: fixedNow });
    const a = await svc.jot({ text: 'alice private thought', userId: 'alice', tenantId: null });
    const b = await svc.jot({ text: 'bob private thought', userId: 'bob', tenantId: null });
    expect(a.noteId).not.toBe(b.noteId);
    expect(await db.getNote(a.noteId!, 'bob')).toBeNull(); // bob cannot read alice's inbox
  });
});
