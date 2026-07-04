/**
 * memory-list.test.ts — unit tests for the pure Memory presentation logic.
 */
import { describe, expect, it } from 'vitest';
import type { CreatedMemory, MemoryItem, Memories } from '@weaveintel/api-client';
import {
  CLEAR_ALL_CONFIRM_PHRASE,
  MEMORY_CONTENT_MAX,
  MEMORY_KIND_ORDER,
  addAuthoredMemory,
  applyCorrection,
  clearAllMemories,
  countMemories,
  defaultMemoryKind,
  isClearAllConfirmed,
  memoriesForKind,
  memoryConversationId,
  memoryIsLocked,
  memoryKindIcon,
  memoryKindLabel,
  provenanceLabel,
  removeMemoryItem,
  validateMemoryContent,
} from './memory-list.js';

type Groups = Memories['memories'];

function item(over: Partial<MemoryItem> & { id: string }): MemoryItem {
  return { content: 'x', kind: 'semantic', ...over };
}

function groups(over: Partial<Groups> = {}): Groups {
  return { semantic: [], entity: [], 'user-authored': [], ...over };
}

describe('kind metadata', () => {
  it('orders user-authored first', () => {
    expect(MEMORY_KIND_ORDER[0]).toBe('user-authored');
    expect(MEMORY_KIND_ORDER).toHaveLength(3);
  });

  it('labels and icons each kind', () => {
    expect(memoryKindLabel('user-authored')).toBe('Your notes');
    expect(memoryKindLabel('semantic')).toBe('Learned');
    expect(memoryKindLabel('entity')).toBe('Entities');
    expect(memoryKindIcon('user-authored')).toBe('authored');
    expect(memoryKindIcon('semantic')).toBe('memory');
    expect(memoryKindIcon('entity')).toBe('entity');
  });
});

describe('memoriesForKind / countMemories', () => {
  it('returns a copy of the kind rows and counts across kinds', () => {
    const g = groups({
      semantic: [item({ id: 's1' })],
      entity: [item({ id: 'e1', kind: 'entity' }), item({ id: 'e2', kind: 'entity' })],
      'user-authored': [item({ id: 'u1', kind: 'user-authored' })],
    });
    expect(memoriesForKind(g, 'entity').map((m) => m.id)).toEqual(['e1', 'e2']);
    expect(memoriesForKind(g, 'entity')).not.toBe(g.entity);
    expect(countMemories(g)).toBe(4);
  });
});

describe('defaultMemoryKind', () => {
  it('falls back to user-authored when everything is empty', () => {
    expect(defaultMemoryKind(groups())).toBe('user-authored');
  });

  it('prefers user-authored when notes exist', () => {
    const g = groups({
      'user-authored': [item({ id: 'u1', kind: 'user-authored' })],
      entity: [item({ id: 'e1', kind: 'entity' })],
    });
    expect(defaultMemoryKind(g)).toBe('user-authored');
  });

  it('opens on the first populated tab when notes are empty', () => {
    const entityOnly = groups({ entity: [item({ id: 'e1', kind: 'entity' })] });
    expect(defaultMemoryKind(entityOnly)).toBe('entity');
    const learnedOnly = groups({ semantic: [item({ id: 's1' })] });
    expect(defaultMemoryKind(learnedOnly)).toBe('semantic');
  });
});

describe('provenanceLabel', () => {
  it('credits the user for authored memory', () => {
    expect(provenanceLabel(item({ id: 'u', kind: 'user-authored' }))).toBe('Added by you');
    expect(provenanceLabel(item({ id: 'u', kind: 'semantic', provenance: { source: 'user' } }))).toBe('Added by you');
  });

  it('prefers verified, then extracted, then conversation', () => {
    expect(provenanceLabel(item({ id: 'v', provenance: { verifiedBy: 'an operator' } }))).toBe('Verified by an operator');
    expect(provenanceLabel(item({ id: 'x', provenance: { extractedBy: 'gpt-4o' } }))).toBe('Extracted by gpt-4o');
    expect(provenanceLabel(item({ id: 'c', provenance: { source: 'conversation' } }))).toBe('Learned from a conversation');
  });

  it('appends confidence when present and valid', () => {
    expect(provenanceLabel(item({ id: 'x', provenance: { extractedBy: 'gpt-4o', confidence: 0.823 } }))).toBe(
      'Extracted by gpt-4o · 82% confidence',
    );
  });

  it('falls back when provenance is empty', () => {
    expect(provenanceLabel(item({ id: 'x', provenance: {} }))).toBe('Learned automatically');
    expect(provenanceLabel(item({ id: 'x' }))).toBe('Learned automatically');
  });
});

describe('memoryConversationId', () => {
  it('reads sourceRunId from provenance', () => {
    expect(memoryConversationId(item({ id: 'x', provenance: { sourceRunId: 'run_42' } }))).toBe('run_42');
    expect(memoryConversationId(item({ id: 'x' }))).toBe(null);
  });
});

describe('memoryIsLocked', () => {
  it('detects the org-managed flag at top level or in provenance', () => {
    expect(memoryIsLocked({ ...item({ id: 'x' }), managedByOrg: true } as MemoryItem)).toBe(true);
    expect(memoryIsLocked(item({ id: 'x', provenance: { managedByOrg: true } }))).toBe(true);
    expect(memoryIsLocked(item({ id: 'x' }))).toBe(false);
  });
});

describe('validateMemoryContent', () => {
  it('trims and accepts in-bounds content', () => {
    expect(validateMemoryContent('  hi  ')).toEqual({ ok: true, value: 'hi' });
  });

  it('rejects empty and overlong content', () => {
    expect(validateMemoryContent('   ').ok).toBe(false);
    expect(validateMemoryContent('a'.repeat(MEMORY_CONTENT_MAX + 1)).ok).toBe(false);
    expect(validateMemoryContent('a'.repeat(MEMORY_CONTENT_MAX)).ok).toBe(true);
  });
});

describe('clear-all confirmation', () => {
  it('requires the exact phrase', () => {
    expect(isClearAllConfirmed(CLEAR_ALL_CONFIRM_PHRASE)).toBe(true);
    expect(isClearAllConfirmed('  DELETE  ')).toBe(true);
    expect(isClearAllConfirmed('delete')).toBe(false);
    expect(isClearAllConfirmed('')).toBe(false);
  });
});

describe('optimistic mutations', () => {
  it('removes a row from any kind', () => {
    const g = groups({ semantic: [item({ id: 's1' })], 'user-authored': [item({ id: 'u1', kind: 'user-authored' })] });
    const out = removeMemoryItem(g, 's1');
    expect(out.semantic).toHaveLength(0);
    expect(out['user-authored']).toHaveLength(1);
  });

  it('prepends a created authored memory', () => {
    const created: CreatedMemory = { id: 'n1', content: 'new note', kind: 'user-authored', createdAt: '2026-01-01T00:00:00Z' };
    const out = addAuthoredMemory(groups(), created);
    expect(out['user-authored'][0]!.id).toBe('n1');
    expect(out['user-authored'][0]!.content).toBe('new note');
  });

  it('applies a correction: drops the original and adds the lineage row', () => {
    const g = groups({ semantic: [item({ id: 'old', content: 'wrong' })] });
    const created: CreatedMemory = { id: 'new', content: 'right', kind: 'user-authored', correctedFrom: 'old' };
    const out = applyCorrection(g, 'old', created);
    expect(out.semantic).toHaveLength(0);
    expect(out['user-authored'][0]!.id).toBe('new');
    expect((out['user-authored'][0]!.provenance as Record<string, unknown>)['correctedFrom']).toBe('old');
  });

  it('clears every kind', () => {
    const out = clearAllMemories();
    expect(countMemories(out)).toBe(0);
  });
});
