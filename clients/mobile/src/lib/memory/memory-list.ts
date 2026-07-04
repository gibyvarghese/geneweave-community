/**
 * memory-list.ts — pure presentation logic for the Memory screens (M8).
 *
 * Frameworks-free: no React, no react-native, no network. Takes the grouped
 * `Memories` from `GET /api/me/memories` and produces the per-kind sections the
 * Memory screen renders, the provenance line under each row, the lock state for
 * org-managed memory, and the optimistic local mutations (add / correct /
 * remove / clear). The native screen stays a thin view over these helpers, so
 * the grouping, provenance shaping, lineage on correction, and edit-as-sentence
 * validation are all unit-tested in Node.
 *
 * "Edit as a sentence": a user corrects a memory by rewriting it in plain
 * language. The server records the correction as a NEW user-authored row with
 * `correctedFrom` pointing at the original (which it supersedes), so lineage is
 * preserved. The optimistic {@link applyCorrection} mirrors that: it removes the
 * original from its kind and prepends the corrected row to user-authored.
 */

import type { CreatedMemory, MemoryItem, Memories } from '@weaveintel/api-client';

/** The three memory kinds the server groups by. */
export type MemoryKind = 'user-authored' | 'semantic' | 'entity';

/** The inner grouped map (`Memories['memories']`). */
export type MemoryGroups = Memories['memories'];

/**
 * Tab order for the Memory screen: the user's own notes first (the only kind
 * they create directly), then the agent-learned insights and extracted
 * entities.
 */
export const MEMORY_KIND_ORDER: readonly MemoryKind[] = ['user-authored', 'semantic', 'entity'] as const;

/** Human label for a memory kind tab. */
export function memoryKindLabel(kind: MemoryKind): string {
  switch (kind) {
    case 'user-authored':
      return 'Your notes';
    case 'semantic':
      return 'Learned';
    case 'entity':
      return 'Entities';
  }
}

/** The semantic icon name for a memory kind (resolved by the central Icon). */
export function memoryKindIcon(kind: MemoryKind): 'authored' | 'memory' | 'entity' {
  switch (kind) {
    case 'user-authored':
      return 'authored';
    case 'semantic':
      return 'memory';
    case 'entity':
      return 'entity';
  }
}

/** The rows for a given kind, in server order (server already hides superseded). */
export function memoriesForKind(groups: MemoryGroups, kind: MemoryKind): MemoryItem[] {
  return [...(groups[kind] ?? [])];
}

/** Total number of memory rows across all kinds. */
export function countMemories(groups: MemoryGroups): number {
  return MEMORY_KIND_ORDER.reduce((sum, kind) => sum + (groups[kind]?.length ?? 0), 0);
}

/**
 * The kind a freshly-loaded Memory screen should open on: the first kind (in
 * display order) that actually has rows, so a user whose only memory is an
 * extracted entity or a learned insight lands on a populated tab instead of an
 * empty "Your notes". Falls back to 'user-authored' when everything is empty.
 */
export function defaultMemoryKind(groups: MemoryGroups): MemoryKind {
  return MEMORY_KIND_ORDER.find((kind) => (groups[kind]?.length ?? 0) > 0) ?? 'user-authored';
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Narrow the open `provenance` record to the fields we surface. */
interface Provenance {
  source?: unknown;
  confidence?: unknown;
  extractedBy?: unknown;
  verifiedBy?: unknown;
  sourceRunId?: unknown;
  sourceRef?: unknown;
}

function provenanceOf(item: MemoryItem): Provenance {
  const p = item.provenance;
  return typeof p === 'object' && p !== null ? (p as Provenance) : {};
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * A short, human provenance line shown under a memory row, e.g.
 *   "Added by you", "Learned from a conversation",
 *   "Extracted by gpt-4o · 82% confidence", "Verified by an operator".
 * Always returns a non-empty string so the row never shows a blank subtitle.
 */
export function provenanceLabel(item: MemoryItem): string {
  const p = provenanceOf(item);
  const source = asString(p.source);
  const extractedBy = asString(p.extractedBy);
  const verifiedBy = asString(p.verifiedBy);

  let base: string;
  if (source === 'user' || item.kind === 'user-authored') {
    base = 'Added by you';
  } else if (verifiedBy) {
    base = `Verified by ${verifiedBy}`;
  } else if (extractedBy) {
    base = `Extracted by ${extractedBy}`;
  } else if (source === 'conversation' || p.sourceRunId) {
    base = 'Learned from a conversation';
  } else if (source) {
    base = `From ${source}`;
  } else {
    base = 'Learned automatically';
  }

  const confidence = typeof p.confidence === 'number' ? p.confidence : null;
  if (confidence !== null && confidence >= 0 && confidence <= 1) {
    base += ` · ${Math.round(confidence * 100)}% confidence`;
  }
  return base;
}

/** The originating run id for a memory row (deep-link target), or null. */
export function memoryConversationId(item: MemoryItem): string | null {
  return asString(provenanceOf(item).sourceRunId);
}

// ---------------------------------------------------------------------------
// Lock state (org-managed memory)
// ---------------------------------------------------------------------------

/**
 * True when a memory row is centrally managed by the organization and therefore
 * read-only. The server surfaces this as a `managedByOrg` flag on the item (or
 * inside provenance); reads are always allowed, mutations fail with 403.
 */
export function memoryIsLocked(item: MemoryItem): boolean {
  const top = (item as Record<string, unknown>)['managedByOrg'];
  if (top === true) return true;
  const p = provenanceOf(item) as Record<string, unknown>;
  return p['managedByOrg'] === true;
}

// ---------------------------------------------------------------------------
// Edit-as-sentence validation
// ---------------------------------------------------------------------------

/** Server bounds for memory content (mirrors me-memories.ts: 1..2000 chars). */
export const MEMORY_CONTENT_MAX = 2000;

export type MemoryContentValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Trim + bound-check the edited sentence before a create / correct call. */
export function validateMemoryContent(text: string): MemoryContentValidation {
  const value = text.trim();
  if (value.length === 0) return { ok: false, error: 'Write something to remember.' };
  if (value.length > MEMORY_CONTENT_MAX) {
    return { ok: false, error: `Keep it under ${MEMORY_CONTENT_MAX} characters.` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Clear-all double confirmation
// ---------------------------------------------------------------------------

/** The exact phrase the user must type to confirm clearing all memory. */
export const CLEAR_ALL_CONFIRM_PHRASE = 'DELETE';

/** True when the typed confirmation matches the required phrase (case-sensitive). */
export function isClearAllConfirmed(typed: string): boolean {
  return typed.trim() === CLEAR_ALL_CONFIRM_PHRASE;
}

// ---------------------------------------------------------------------------
// Optimistic mutations (pure — return a new MemoryGroups)
// ---------------------------------------------------------------------------

function emptyGroups(): MemoryGroups {
  return { semantic: [], entity: [], 'user-authored': [] };
}

/** Remove a memory row by id from every kind. Pure. */
export function removeMemoryItem(groups: MemoryGroups, id: string): MemoryGroups {
  return {
    semantic: groups.semantic.filter((m) => m.id !== id),
    entity: groups.entity.filter((m) => m.id !== id),
    'user-authored': groups['user-authored'].filter((m) => m.id !== id),
  };
}

/** Prepend a newly-created user-authored memory. Pure. */
export function addAuthoredMemory(groups: MemoryGroups, created: CreatedMemory): MemoryGroups {
  const item: MemoryItem = {
    id: created.id,
    content: created.content,
    kind: 'user-authored',
    ...(created.createdAt !== undefined ? { createdAt: created.createdAt } : {}),
    provenance: { source: 'user' },
  };
  return { ...groups, 'user-authored': [item, ...groups['user-authored']] };
}

/**
 * Apply a correction: drop the original row from whichever kind it lived in and
 * prepend the corrected user-authored row (carrying `correctedFrom` lineage).
 * Pure.
 */
export function applyCorrection(groups: MemoryGroups, originalId: string, created: CreatedMemory): MemoryGroups {
  const without = removeMemoryItem(groups, originalId);
  const item: MemoryItem = {
    id: created.id,
    content: created.content,
    kind: 'user-authored',
    ...(created.createdAt !== undefined ? { createdAt: created.createdAt } : {}),
    provenance: {
      source: 'user',
      ...(created.correctedFrom !== undefined ? { correctedFrom: created.correctedFrom } : {}),
    },
  };
  return { ...without, 'user-authored': [item, ...without['user-authored']] };
}

/** Clear every kind. Pure. */
export function clearAllMemories(): MemoryGroups {
  return emptyGroups();
}
