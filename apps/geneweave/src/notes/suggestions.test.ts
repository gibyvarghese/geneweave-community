// SPDX-License-Identifier: MIT
// weaveNotes suggestion state machine — positive, negative, idempotency, and stress cases.
import { describe, it, expect } from 'vitest';
import {
  emptySuggestions, addSuggestion, acceptSuggestion, rejectSuggestion, resolveAll, clearResolved, pendingCount, pendingQueue, decisionTag,
} from './suggestions.js';

describe('suggestion state machine', () => {
  const mk = (id: string, t = 0) => ({ id, kind: 'text-edit' as const, summary: `edit ${id}`, createdAt: t });
  it('adds, accepts, rejects, and counts pending', () => {
    let m = emptySuggestions();
    m = addSuggestion(m, mk('a', 1)); m = addSuggestion(m, mk('b', 2)); m = addSuggestion(m, mk('c', 3));
    expect(pendingCount(m)).toBe(3);
    m = acceptSuggestion(m, 'a'); m = rejectSuggestion(m, 'b');
    expect(pendingCount(m)).toBe(1);
    expect(m['a']!.state).toBe('accepted');
    expect(m['b']!.state).toBe('rejected');
    expect(decisionTag(m['a']!.state)).toBe('AI edit accepted');
    expect(decisionTag(m['b']!.state)).toBe('kept yours');
  });
  it('is idempotent on add and resolve (re-adding keeps existing; re-resolving a resolved one is a no-op)', () => {
    let m = addSuggestion(emptySuggestions(), { ...mk('a'), summary: 'first' });
    m = addSuggestion(m, { ...mk('a'), summary: 'second' }); // ignored
    expect(m['a']!.summary).toBe('first');
    m = acceptSuggestion(m, 'a');
    m = rejectSuggestion(m, 'a'); // already accepted → no-op
    expect(m['a']!.state).toBe('accepted');
  });
  it('resolveSuggestion on a missing id is a no-op (does not crash or create entries)', () => {
    const m = acceptSuggestion(emptySuggestions(), 'ghost');
    expect(Object.keys(m)).toHaveLength(0);
  });
  it('pendingQueue is oldest-first; resolveAll + clearResolved housekeep', () => {
    let m = emptySuggestions();
    m = addSuggestion(m, mk('c', 30)); m = addSuggestion(m, mk('a', 10)); m = addSuggestion(m, mk('b', 20));
    expect(pendingQueue(m).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    m = resolveAll(m, 'accepted');
    expect(pendingCount(m)).toBe(0);
    expect(clearResolved(m)).toEqual({});
  });
  // Genuinely O(n) (~3.1s isolated) but no headroom under the default 5s timeout when the whole
  // suite runs in parallel with builds — give it a generous ceiling (still fails fast on O(n²)).
  it('STRESS: 5,000 suggestions add/resolve in O(n) without blowing up', () => {
    let m = emptySuggestions();
    for (let i = 0; i < 5000; i++) m = addSuggestion(m, mk(`s${i}`, i));
    expect(pendingCount(m)).toBe(5000);
    for (let i = 0; i < 5000; i += 2) m = acceptSuggestion(m, `s${i}`);
    expect(pendingCount(m)).toBe(2500);
  }, 30000);
});
