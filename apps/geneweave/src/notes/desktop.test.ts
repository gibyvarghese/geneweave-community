// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  parseQuickCapture, pushRecent, resolveLastNote,
  buildNotesSnapshot, readNotesSnapshot, snapshotNote,
  DEFAULT_RECENTS_LIMIT, type RecentNote,
} from './desktop.js';

describe('desktop — quick capture parsing', () => {
  it('uses the first line as the title and the rest as the body', () => {
    const qc = parseQuickCapture('Call the supplier\nask about the March invoice\nand the delivery date');
    expect(qc.title).toBe('Call the supplier');
    expect(qc.body).toBe('ask about the March invoice\nand the delivery date');
    expect(qc.templateKey).toBeUndefined();
  });

  it('recognises a /template hint and strips it from the title', () => {
    const qc = parseQuickCapture('/meeting Q3 planning sync\nattendees: ...');
    expect(qc.templateKey).toBe('meeting-minutes');
    expect(qc.title).toBe('Q3 planning sync');
    expect(qc.body).toBe('attendees: ...');
  });

  it('recognises a "kind:" hint (todo: → action board)', () => {
    const qc = parseQuickCapture('todo: ship the desktop build');
    expect(qc.templateKey).toBe('action-board');
    expect(qc.title).toBe('ship the desktop build');
  });

  it('accepts a direct template key (/cornell)', () => {
    const qc = parseQuickCapture('/cornell Biology lecture 4');
    expect(qc.templateKey).toBe('cornell');
    expect(qc.title).toBe('Biology lecture 4');
  });

  it('leaves an unknown hint as plain text (no template)', () => {
    const qc = parseQuickCapture('/banana split the bill');
    expect(qc.templateKey).toBeUndefined();
    expect(qc.title).toBe('/banana split the bill');
  });

  it('NEGATIVE: empty / whitespace input becomes an Untitled note', () => {
    expect(parseQuickCapture('').title).toBe('Untitled');
    expect(parseQuickCapture('   \n  \n').title).toBe('Untitled');
    expect(parseQuickCapture('').body).toBe('');
  });

  it('SECURITY/STRESS: an enormous title is capped and never throws', () => {
    const qc = parseQuickCapture('x'.repeat(10_000) + '\nbody');
    expect(qc.title.length).toBeLessThanOrEqual(120);
    expect(qc.body).toBe('body');
  });
});

describe('desktop — recents / open-to-last-note', () => {
  it('moves an opened note to the front, dedupes by id, and caps the list', () => {
    let recents: RecentNote[] = [];
    recents = pushRecent(recents, { id: 'a', title: 'A' }, '2026-06-01T00:00:00Z');
    recents = pushRecent(recents, { id: 'b', title: 'B' }, '2026-06-02T00:00:00Z');
    recents = pushRecent(recents, { id: 'a', title: 'A (edited)' }, '2026-06-03T00:00:00Z'); // re-open A
    expect(recents.map((r) => r.id)).toEqual(['a', 'b']); // A back to front, no dup
    expect(recents[0]!.title).toBe('A (edited)');
    expect(resolveLastNote(recents)?.id).toBe('a');
  });

  it('respects the recents limit', () => {
    let recents: RecentNote[] = [];
    for (let i = 0; i < DEFAULT_RECENTS_LIMIT + 5; i++) recents = pushRecent(recents, { id: `n${i}`, title: `N${i}` }, `2026-06-${(i % 28) + 1}T00:00:00Z`);
    expect(recents.length).toBe(DEFAULT_RECENTS_LIMIT);
  });

  it('resolveLastNote returns null on an empty list', () => {
    expect(resolveLastNote([])).toBeNull();
  });
});

describe('desktop — offline snapshot', () => {
  const notes = [
    { id: 'n1', title: 'Old', icon: '📄', favorite: 0, doc_json: '{"type":"doc","content":[]}', updated_at: '2026-06-01T00:00:00Z' },
    { id: 'n2', title: 'New', icon: null, favorite: 1, doc_json: '{"type":"doc","content":[{"type":"paragraph"}]}', updated_at: '2026-06-09T00:00:00Z' },
  ];

  it('builds a capped, most-recent-first snapshot and round-trips it', () => {
    const snap = buildNotesSnapshot(notes, '2026-06-10T00:00:00Z');
    expect(snap.v).toBe(1);
    expect(snap.notes[0]!.id).toBe('n2'); // newest first
    const round = readNotesSnapshot(JSON.stringify(snap))!;
    expect(round.notes).toHaveLength(2);
    expect(snapshotNote(round, 'n1')!.title).toBe('Old');   // can open the last note offline
    expect(snapshotNote(round, 'nope')).toBeNull();
  });

  it('caps the snapshot to the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, updated_at: `2026-06-${(i % 28) + 1}T00:00:00Z` }));
    expect(buildNotesSnapshot(many, '2026-06-30T00:00:00Z', 10).notes).toHaveLength(10);
  });

  it('NEGATIVE: missing / corrupt / old-version snapshots return null (fail-safe)', () => {
    expect(readNotesSnapshot(null)).toBeNull();
    expect(readNotesSnapshot('not json{')).toBeNull();
    expect(readNotesSnapshot('{"v":99,"notes":[]}')).toBeNull();
    expect(readNotesSnapshot('{"v":1}')).toBeNull(); // notes not an array
  });

  it('SECURITY: a tampered snapshot drops malformed entries, keeps valid ones', () => {
    const tampered = JSON.stringify({ v: 1, savedAt: 't', notes: [
      { id: 'ok', doc_json: '{}', title: 'fine', icon: null, favorite: 0, updated_at: 't' },
      { id: 123, doc_json: '{}' },          // bad id
      { title: 'no id' },                    // missing id
      { id: 'bad', doc_json: 42 },           // non-string doc
    ] });
    const snap = readNotesSnapshot(tampered)!;
    expect(snap.notes.map((n) => n.id)).toEqual(['ok']);
  });

  it('STRESS: a 5,000-note workspace snapshots within the cap without throwing', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, doc_json: '{}', updated_at: '2026-06-01T00:00:00Z' }));
    const snap = buildNotesSnapshot(huge, '2026-06-02T00:00:00Z', 500);
    expect(snap.notes).toHaveLength(500);
  });
});
