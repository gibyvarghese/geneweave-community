/**
 * history.test.ts — Node unit tests for transcript hydration (messagesToEntries).
 */
import { describe, it, expect } from 'vitest';
import { messagesToEntries } from './history.js';
import { isTerminalStatus } from './chat-session.js';

describe('messagesToEntries', () => {
  it('maps user and assistant turns to bubbles in order', () => {
    const entries = messagesToEntries([
      { id: 'm1', role: 'user', content: 'Who are you?', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'm2', role: 'assistant', content: 'I am GeneWeave.', createdAt: '2026-01-01T00:00:02.000Z' },
    ]);
    expect(entries).toHaveLength(2);
    const [user, assistant] = entries;
    expect(user).toMatchObject({ kind: 'user', id: 'm1', text: 'Who are you?' });
    expect(assistant?.kind).toBe('assistant');
    if (assistant?.kind === 'assistant') {
      expect(assistant.runId).toBe('m2');
      expect(assistant.model.fullText).toBe('I am GeneWeave.');
      expect(isTerminalStatus(assistant.model.status)).toBe(true);
      // Linked back to the preceding user turn for regenerate/edit.
      expect(assistant.promptEntryId).toBe('m1');
      expect(assistant.promptText).toBe('Who are you?');
    }
  });

  it('skips system and tool rows', () => {
    const entries = messagesToEntries([
      { id: 'sys', role: 'system', content: 'You are helpful.', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm1', role: 'user', content: 'Hi', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'tool', role: 'tool', content: '{"r":1}', createdAt: '2026-01-01T00:00:02.000Z' },
      { id: 'm2', role: 'assistant', content: 'Hello', createdAt: '2026-01-01T00:00:03.000Z' },
    ]);
    expect(entries.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  it('parses createdAt into a numeric timestamp and tolerates bad dates', () => {
    const [good, bad] = messagesToEntries([
      { id: 'm1', role: 'user', content: 'a', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'm2', role: 'user', content: 'b', createdAt: 'not-a-date' },
    ]);
    expect(good?.createdAt).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(bad?.createdAt).toBe(0);
  });

  it('returns an empty transcript for no messages', () => {
    expect(messagesToEntries([])).toEqual([]);
  });

  it('leaves an orphan assistant turn with empty prompt links', () => {
    const [assistant] = messagesToEntries([
      { id: 'm1', role: 'assistant', content: 'orphaned', createdAt: '2026-01-01T00:00:01.000Z' },
    ]);
    expect(assistant?.kind).toBe('assistant');
    if (assistant?.kind === 'assistant') {
      expect(assistant.promptEntryId).toBe('');
      expect(assistant.promptText).toBe('');
    }
  });
});
