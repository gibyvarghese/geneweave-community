/**
 * conversation-list.test.ts — pure unit tests for the Chats tab logic (M6).
 */
import { describe, it, expect } from 'vitest';
import type { Conversation } from '@weaveintel/api-client';
import {
  isActiveRunStatus,
  filterConversations,
  sectionizeConversations,
  buildConversationView,
  applyConversationPatch,
  countConversations,
  formatRelativeTimestamp,
} from './conversation-list.js';

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    id: over.id,
    title: over.title ?? `Conversation ${over.id}`,
    snippet: over.snippet ?? null,
    mode: over.mode ?? 'agent',
    updatedAt: over.updatedAt ?? '2026-06-01T00:00:00.000Z',
    runStatus: over.runStatus ?? null,
    pinned: over.pinned ?? false,
    archived: over.archived ?? false,
    hasPendingAction: over.hasPendingAction ?? false,
    participants: over.participants ?? ['u1'],
    unread: over.unread ?? false,
  };
}

describe('isActiveRunStatus', () => {
  it('recognizes live run states and rejects terminal/null', () => {
    expect(isActiveRunStatus('running')).toBe(true);
    expect(isActiveRunStatus('streaming')).toBe(true);
    expect(isActiveRunStatus('completed')).toBe(false);
    expect(isActiveRunStatus(null)).toBe(false);
    expect(isActiveRunStatus(undefined)).toBe(false);
  });
});

describe('filterConversations', () => {
  const items = [
    conv({ id: 'a', title: 'Budget planning', snippet: 'Q3 forecast' }),
    conv({ id: 'b', title: 'Trip ideas', snippet: 'flights to Tokyo', pinned: true }),
    conv({ id: 'c', title: 'Standup notes', hasPendingAction: true }),
    conv({ id: 'd', title: 'Archived thread', archived: true }),
    conv({ id: 'e', title: 'Research run', mode: 'research' }),
  ];

  it('excludes archived always', () => {
    expect(filterConversations(items).map((c) => c.id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('matches query against title and snippet, case-insensitive', () => {
    expect(filterConversations(items, { query: 'tokyo' }).map((c) => c.id)).toEqual(['b']);
    expect(filterConversations(items, { query: 'BUDGET' }).map((c) => c.id)).toEqual(['a']);
  });

  it('chip=pinned keeps only pinned', () => {
    expect(filterConversations(items, { chip: 'pinned' }).map((c) => c.id)).toEqual(['b']);
  });

  it('chip=pending keeps only conversations with a pending action', () => {
    expect(filterConversations(items, { chip: 'pending' }).map((c) => c.id)).toEqual(['c']);
  });

  it('mode filter narrows to a single mode', () => {
    expect(filterConversations(items, { mode: 'research' }).map((c) => c.id)).toEqual(['e']);
  });
});

describe('sectionizeConversations', () => {
  it('buckets into running / pinned / recent with first-match-wins', () => {
    const items = [
      conv({ id: 'run', runStatus: 'running', pinned: true }), // running wins over pinned
      conv({ id: 'pin', pinned: true }),
      conv({ id: 'rec1' }),
      conv({ id: 'rec2' }),
    ];
    const sections = sectionizeConversations(items);
    expect(sections.map((s) => s.id)).toEqual(['running', 'pinned', 'recent']);
    expect(sections[0]!.items.map((c) => c.id)).toEqual(['run']);
    expect(sections[1]!.items.map((c) => c.id)).toEqual(['pin']);
    expect(sections[2]!.items.map((c) => c.id)).toEqual(['rec1', 'rec2']);
  });

  it('drops empty sections', () => {
    const sections = sectionizeConversations([conv({ id: 'x' })]);
    expect(sections.map((s) => s.id)).toEqual(['recent']);
  });

  it('sorts each section newest-first', () => {
    const items = [
      conv({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      conv({ id: 'new', updatedAt: '2026-06-01T00:00:00.000Z' }),
      conv({ id: 'mid', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(sectionizeConversations(items)[0]!.items.map((c) => c.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('buildConversationView', () => {
  it('filters then sectionizes', () => {
    const items = [
      conv({ id: 'a', title: 'budget', pinned: true }),
      conv({ id: 'b', title: 'trip' }),
      conv({ id: 'c', title: 'budget review', archived: true }),
    ];
    const sections = buildConversationView(items, { query: 'budget' });
    expect(countConversations(sections)).toBe(1);
    expect(sections[0]!.id).toBe('pinned');
    expect(sections[0]!.items[0]!.id).toBe('a');
  });
});

describe('applyConversationPatch', () => {
  const items = [conv({ id: 'a', pinned: false }), conv({ id: 'b' })];

  it('pins in place', () => {
    const out = applyConversationPatch(items, 'a', { pinned: true });
    expect(out.find((c) => c.id === 'a')!.pinned).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('archiving removes the row from the active list', () => {
    const out = applyConversationPatch(items, 'a', { archived: true });
    expect(out.map((c) => c.id)).toEqual(['b']);
  });

  it('renames in place', () => {
    const out = applyConversationPatch(items, 'b', { title: 'Renamed' });
    expect(out.find((c) => c.id === 'b')!.title).toBe('Renamed');
  });

  it('passes through unknown ids unchanged', () => {
    expect(applyConversationPatch(items, 'zzz', { pinned: true })).toEqual(items);
  });
});

describe('formatRelativeTimestamp', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');

  it('returns empty string for missing or invalid input', () => {
    expect(formatRelativeTimestamp(null, now)).toBe('');
    expect(formatRelativeTimestamp(undefined, now)).toBe('');
    expect(formatRelativeTimestamp('not-a-date', now)).toBe('');
  });

  it('formats sub-minute as now', () => {
    expect(formatRelativeTimestamp('2026-06-10T11:59:30.000Z', now)).toBe('now');
  });

  it('formats minutes, hours, days, and weeks', () => {
    expect(formatRelativeTimestamp('2026-06-10T11:30:00.000Z', now)).toBe('30m');
    expect(formatRelativeTimestamp('2026-06-10T09:00:00.000Z', now)).toBe('3h');
    expect(formatRelativeTimestamp('2026-06-08T12:00:00.000Z', now)).toBe('2d');
    expect(formatRelativeTimestamp('2026-05-27T12:00:00.000Z', now)).toBe('2w');
  });

  it('treats future timestamps as now', () => {
    expect(formatRelativeTimestamp('2026-06-10T12:05:00.000Z', now)).toBe('now');
  });
});
