// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the AI-suggestion state machine (weaveNotes Phase 0).
 *
 * Every change the AI proposes to a note is a SUGGESTION, never a silent write (spec §4.2):
 * the human reviews it and accepts (✓) or rejects (✕). Because multiple AI rounds can queue
 * while you review, the app tracks a KEYED MAP of suggestion-id → state, not a single flag.
 * This module is the pure, framework-free reducer behind that — so the web editor, the inline
 * diff, the human-tasks approval, and (later) mobile all agree on what "pending/accepted/
 * rejected" means and transition the same way.
 *
 * It also models WHAT a suggestion is about (text edit, colour, ink, a diagram…) so the UI can
 * render the right geneWeave component (inline diff vs AI-block byline) and so an audit trail
 * records exactly what the AI touched.
 *
 * --- For someone new to this ---
 * It is "tracked changes" in a word processor: the AI marks up the page, you click ✓ to keep a
 * change or ✕ to throw it away. This file is just the bookkeeping for which marks are still
 * waiting on you, which you kept, and which you discarded — nothing visual, just the rules.
 */

/** The kind of change a suggestion represents (drives which UI component renders it). */
export type SuggestionKind =
  | 'text-edit'       // replace a range of text → inline diff
  | 'insert-block'    // add a new block
  | 'text-color'      // recolour text
  | 'highlight'       // highlight text
  | 'colorize'        // semantic colour-coding across a scope
  | 'ink'             // draw/recolour strokes
  | 'diagram'         // an Excalidraw scene / mind map / mermaid
  | 'artifact';       // an opaque image/svg fallback

export type SuggestionState = 'pending' | 'accepted' | 'rejected';

/** A single proposed change, authored by the AI, awaiting human review. */
export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  /** A short, plain summary for the reviewer ("Rewrote the intro", "Coloured risks red"). */
  summary: string;
  /** The block/range the suggestion targets (opaque to this module). */
  anchor?: string;
  /** Optional before/after preview for the inline diff. */
  before?: string;
  after?: string;
  state: SuggestionState;
  /** When the AI proposed it (ms epoch); supplied by the caller (kept pure). */
  createdAt: number;
}

/** A keyed collection of suggestions in flight on a note. */
export type SuggestionMap = Record<string, Suggestion>;

/** Create a fresh, empty suggestion map. */
export function emptySuggestions(): SuggestionMap { return {}; }

/** Add a new pending suggestion (idempotent on id — re-adding keeps the existing one). */
export function addSuggestion(map: SuggestionMap, s: Omit<Suggestion, 'state'> & { state?: SuggestionState }): SuggestionMap {
  if (map[s.id]) return map;
  return { ...map, [s.id]: { ...s, state: s.state ?? 'pending' } };
}

/** Transition a suggestion to accepted/rejected. No-op if it does not exist or is already resolved. */
export function resolveSuggestion(map: SuggestionMap, id: string, state: 'accepted' | 'rejected'): SuggestionMap {
  const cur = map[id];
  if (!cur || cur.state !== 'pending') return map;
  return { ...map, [id]: { ...cur, state } };
}

/** Accept / reject convenience wrappers. */
export function acceptSuggestion(map: SuggestionMap, id: string): SuggestionMap { return resolveSuggestion(map, id, 'accepted'); }
export function rejectSuggestion(map: SuggestionMap, id: string): SuggestionMap { return resolveSuggestion(map, id, 'rejected'); }

/** Accept (or reject) every pending suggestion at once. */
export function resolveAll(map: SuggestionMap, state: 'accepted' | 'rejected'): SuggestionMap {
  const out: SuggestionMap = {};
  for (const [id, s] of Object.entries(map)) out[id] = s.state === 'pending' ? { ...s, state } : s;
  return out;
}

/** Drop resolved suggestions from the map (housekeeping after a review pass). */
export function clearResolved(map: SuggestionMap): SuggestionMap {
  const out: SuggestionMap = {};
  for (const [id, s] of Object.entries(map)) if (s.state === 'pending') out[id] = s;
  return out;
}

/** How many suggestions are still waiting on the human. */
export function pendingCount(map: SuggestionMap): number {
  let n = 0;
  for (const s of Object.values(map)) if (s.state === 'pending') n++;
  return n;
}

/** The pending suggestions, oldest first (the review queue). */
export function pendingQueue(map: SuggestionMap): Suggestion[] {
  return Object.values(map).filter((s) => s.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}

/** The reviewer-facing tag shown after a decision ("AI edit accepted" / "kept yours"). */
export function decisionTag(state: SuggestionState): string {
  return state === 'accepted' ? 'AI edit accepted' : state === 'rejected' ? 'kept yours' : '';
}
