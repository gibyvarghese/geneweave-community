/**
 * conversation-list.ts — pure presentation logic for the Chats tab (M6).
 *
 * Frameworks-free: no React, no react-native, no network. Takes the
 * `Conversation[]` returned by `GET /api/me/conversations` plus the current UI
 * query state and produces the sectioned, filtered list the screen renders, and
 * applies optimistic local mutations (pin / archive / rename). The native screen
 * stays a thin view over these functions, so the sectioning + filter rules are
 * unit-tested in Node.
 *
 * Sections (a conversation appears in exactly one, first match wins):
 *   running — a run is currently live (`runStatus` active)
 *   pinned  — pinned and not running
 *   recent  — everything else
 */

import type { Conversation } from '@weaveintel/api-client';

export type ConversationSectionId = 'running' | 'pinned' | 'recent';

export interface ConversationSection {
  id: ConversationSectionId;
  title: string;
  items: Conversation[];
}

/** The filter chips shown above the list. */
export type ConversationChip = 'all' | 'pinned' | 'pending';

const SECTION_TITLES: Record<ConversationSectionId, string> = {
  running: 'Running',
  pinned: 'Pinned',
  recent: 'Recent',
};

// Run lifecycle states that mean "a turn is in flight right now". Kept broad so
// the Running section is forward-compatible with run-backed conversations.
const ACTIVE_RUN_STATUSES = new Set(['running', 'pending', 'queued', 'streaming', 'starting']);

/** True when a conversation has a live run. */
export function isActiveRunStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

export interface ConversationQuery {
  /** Free-text search over title + snippet (case-insensitive). */
  query?: string;
  /** Active filter chip. */
  chip?: ConversationChip;
  /** Optional conversation mode filter (e.g. 'agent', 'research'). */
  mode?: string | null;
}

/** Descending compare on ISO timestamps (newest first); lexicographic is valid for ISO-8601. */
function byUpdatedAtDesc(a: Conversation, b: Conversation): number {
  if (a.updatedAt === b.updatedAt) return 0;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/**
 * Apply the search box + filter chip + mode filter. Archived conversations are
 * always excluded (the server already does this for the default view; this is a
 * defensive client-side guard so an optimistic un-archive/re-archive stays
 * consistent). Pure — returns a new array.
 */
export function filterConversations(items: readonly Conversation[], q: ConversationQuery = {}): Conversation[] {
  const needle = q.query?.trim().toLowerCase() ?? '';
  const chip = q.chip ?? 'all';
  const mode = q.mode ?? null;

  return items.filter((c) => {
    if (c.archived) return false;
    if (chip === 'pinned' && !c.pinned) return false;
    if (chip === 'pending' && !c.hasPendingAction) return false;
    if (mode && c.mode !== mode) return false;
    if (needle) {
      const hay = `${c.title ?? ''} ${c.snippet ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Bucket conversations into Running / Pinned / Recent, each sorted newest-first.
 * Empty sections are dropped so the screen never renders an empty header. Pure.
 */
export function sectionizeConversations(items: readonly Conversation[]): ConversationSection[] {
  const running: Conversation[] = [];
  const pinned: Conversation[] = [];
  const recent: Conversation[] = [];

  for (const c of items) {
    if (isActiveRunStatus(c.runStatus)) running.push(c);
    else if (c.pinned) pinned.push(c);
    else recent.push(c);
  }

  const sections: ConversationSection[] = [
    { id: 'running', title: SECTION_TITLES.running, items: running.sort(byUpdatedAtDesc) },
    { id: 'pinned', title: SECTION_TITLES.pinned, items: pinned.sort(byUpdatedAtDesc) },
    { id: 'recent', title: SECTION_TITLES.recent, items: recent.sort(byUpdatedAtDesc) },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** Filter then sectionize — the full view the Chats screen renders. Pure. */
export function buildConversationView(
  items: readonly Conversation[],
  q: ConversationQuery = {},
): ConversationSection[] {
  return sectionizeConversations(filterConversations(items, q));
}

export interface ConversationFlagPatch {
  pinned?: boolean;
  archived?: boolean;
  title?: string;
}

/**
 * Apply an optimistic flag change to a local list before the server confirms.
 * Archiving removes the row from the list (the default view hides archived);
 * pin/title changes merge in place. Unknown ids pass through unchanged. Pure.
 */
export function applyConversationPatch(
  items: readonly Conversation[],
  id: string,
  patch: ConversationFlagPatch,
): Conversation[] {
  const out: Conversation[] = [];
  for (const c of items) {
    if (c.id !== id) {
      out.push(c);
      continue;
    }
    if (patch.archived === true) continue; // drop from the active list
    out.push({
      ...c,
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    });
  }
  return out;
}

/** Total visible conversation count across all sections (for empty-state logic). */
export function countConversations(sections: readonly ConversationSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/**
 * Compact relative timestamp for a conversation row ("now", "5m", "3h", "2d",
 * "4w", or a localized date for older items). Pure — `now` is injectable so the
 * formatting is deterministic in tests. Invalid / missing input → ''.
 */
export function formatRelativeTimestamp(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = now - then;
  if (diffMs < 0) return 'now';

  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;

  // Older than ~a month: fall back to a short calendar date.
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
