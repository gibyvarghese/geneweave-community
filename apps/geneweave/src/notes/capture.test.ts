// SPDX-License-Identifier: MIT
/**
 * Tests for weaveNotes Phase 7 capture helpers: email parsing (structured + raw, HTML
 * stripped) and provenance note assembly (title, header, source link, body bounding).
 */
import { describe, it, expect } from 'vitest';
import { parseEmail, buildCaptureNote, dailyNoteTitle } from './capture.js';

describe('parseEmail', () => {
  it('parses structured fields and strips HTML from the body', () => {
    const r = parseEmail({ from: 'alice@example.com', subject: 'Lunch?', date: '2026-06-27', body: '<p>Hi <b>Bob</b></p><p>Let\'s meet at noon.</p>' });
    expect(r.from).toBe('alice@example.com');
    expect(r.subject).toBe('Lunch?');
    expect(r.bodyText).toBe('Hi Bob\nLet\'s meet at noon.');
  });
  it('parses a raw RFC822-style message (headers + blank line + body)', () => {
    const raw = 'From: Carol <carol@example.com>\nSubject: Project update\nDate: Mon, 27 Jun 2026\n\nThe milestone is done.\nShipping next week.';
    const r = parseEmail(raw);
    expect(r.from).toBe('Carol <carol@example.com>');
    expect(r.subject).toBe('Project update');
    expect(r.bodyText).toContain('milestone is done');
  });
  it('defaults a missing subject', () => {
    expect(parseEmail({ body: 'no subject here' }).subject).toBe('(no subject)');
  });
});

describe('buildCaptureNote', () => {
  it('assembles a titled note with a provenance header + source link', () => {
    const { title, markdown } = buildCaptureNote({ source: 'web', title: 'A Great Article', body: 'Body text.', sourceLabel: 'example.com', sourceUrl: 'https://example.com/a', capturedAt: '2026-06-27' });
    expect(title).toBe('A Great Article');
    expect(markdown).toContain('# A Great Article');
    expect(markdown).toContain('> 🌐 Captured from example.com · 2026-06-27');
    expect(markdown).toContain('> Source: [https://example.com/a](https://example.com/a)');
    expect(markdown).toContain('Body text.');
  });
  it('defaults the title + bounds the body', () => {
    const { title, markdown } = buildCaptureNote({ source: 'jot', title: '  ', body: 'x'.repeat(50), maxBodyChars: 10 });
    expect(title).toBe('Captured note');
    expect(markdown).toContain('x'.repeat(10));
    expect(markdown).not.toContain('x'.repeat(11));
  });
});

describe('dailyNoteTitle', () => {
  it('formats a per-day title', () => { expect(dailyNoteTitle('2026-06-27')).toBe('Daily Jots — 2026-06-27'); });
});
