// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the AI COLOUR-CODING contract (weaveNotes Phase 2).
 *
 * Phase 2 is the AI selection card: select text, ask the assistant to act, and it proposes
 * a tracked change you accept or reject. One headline action is "colour-code this" — the AI
 * decides which phrases get which colour BY MEANING (by topic, importance, status, sentiment)
 * and highlights them. The danger with letting an AI pick colours is accessibility: a colour
 * it invents might be unreadable. So this module flips the responsibility — the AI only ever
 * picks a semantic LABEL ("risk", "decision", "topic-2"), and THIS module maps that label to a
 * fixed, PRE-VALIDATED WCAG-AA colour. The model can never choose an inaccessible colour.
 *
 * Pure data + pure functions (no DOM, no LLM, zero runtime deps). The accessibility guarantee
 * is enforced by `colorize.test.ts`, which checks every palette colour against the real WCAG
 * contrast maths in `@weaveintel/tokens` — so "pre-validated WCAG-AA palette" is a tested fact,
 * not a promise.
 *
 * --- For someone new to this ---
 * Think of a fixed set of highlighter pens that are all known to be easy to read. When you ask
 * the assistant to "mark the risks red and the decisions green", it does not get to grab any
 * pen it likes — it points at meaning ("this is a risk") and we hand it the right, readable pen.
 */

import { AGENCY_PALETTE } from './agency.js';

/** The reading ink the highlight backgrounds must stay legible UNDER (the note's text colour). */
export const READING_INK = AGENCY_PALETTE.ink; // #14201B

/**
 * The accessible HIGHLIGHT palette (soft backgrounds). Dark reading ink stays comfortably
 * legible on every one of these (proven ≥ AA in the test). Labels are plain colour names so
 * an open-ended "colour-code by topic" can cycle through them.
 */
export const HIGHLIGHT_PALETTE: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'amber', color: '#FAC775' },
  { label: 'pink', color: '#F4C0D1' },
  { label: 'teal', color: '#9FE1CB' },
  { label: 'blue', color: '#B5D4F4' },
  { label: 'lavender', color: '#D9C7F0' },
  { label: 'peach', color: '#FAD3B0' },
  { label: 'sage', color: '#CFE6B5' },
  { label: 'sky', color: '#BFE3EF' },
] as const;

/**
 * The accessible TEXT-colour palette (foregrounds). Each is dark enough to stay ≥ AA on BOTH
 * the Pro white page and the Creative paper surface (proven in the test). Excludes the
 * AI-reserved emerald/mint so coloured user text is never confused with "this is the AI".
 */
export const TEXT_COLOR_PALETTE: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'ink', color: '#14201B' },
  { label: 'coral', color: '#B8431C' },
  { label: 'blue', color: '#1F5FA8' },
  { label: 'green', color: '#0B6B4F' },
  { label: 'purple', color: '#6B3FA0' },
  { label: 'red', color: '#A8281F' },
] as const;

/** The semantic colour-coding schemes the AI may use. Each maps a meaning-label → a safe colour. */
export type ColorScheme = 'topic' | 'importance' | 'status' | 'sentiment';

export interface SchemeBucket { label: string; color: string; hint: string }

/** The fixed label→colour buckets per scheme. `topic` is open-ended (assigned by order). */
export const COLOR_SCHEMES: Record<ColorScheme, SchemeBucket[]> = {
  // Open-ended grouping: the AI invents up to 8 topic names; we colour them by order below.
  topic: HIGHLIGHT_PALETTE.map((p, i) => ({ label: `topic-${i + 1}`, color: p.color, hint: `the ${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} distinct topic` })),
  importance: [
    { label: 'critical', color: '#F4C0D1', hint: 'must-not-miss / blocking' },
    { label: 'high', color: '#FAC775', hint: 'important' },
    { label: 'normal', color: '#BFE3EF', hint: 'ordinary' },
    { label: 'low', color: '#CFE6B5', hint: 'nice-to-have / minor' },
  ],
  status: [
    { label: 'done', color: '#9FE1CB', hint: 'completed' },
    { label: 'in_progress', color: '#FAC775', hint: 'being worked on' },
    { label: 'blocked', color: '#F4C0D1', hint: 'stuck / waiting' },
    { label: 'todo', color: '#B5D4F4', hint: 'not started' },
  ],
  sentiment: [
    { label: 'positive', color: '#CFE6B5', hint: 'good / opportunity' },
    { label: 'neutral', color: '#BFE3EF', hint: 'factual / neutral' },
    { label: 'negative', color: '#F4C0D1', hint: 'risk / problem' },
  ],
};

/** Is this a known colour scheme? */
export function isColorScheme(v: unknown): v is ColorScheme {
  return v === 'topic' || v === 'importance' || v === 'status' || v === 'sentiment';
}

/** The labels the AI is allowed to use for a scheme (what we tell the model). */
export function schemeLabels(scheme: ColorScheme): string[] {
  return COLOR_SCHEMES[scheme].map((b) => b.label);
}

/**
 * Resolve a (scheme, label) to a pre-validated accessible highlight colour, or `null` if the
 * label is not in the scheme. Comparison is case-insensitive and tolerant of spaces/hyphens
 * ("In Progress" → "in_progress") so a slightly-off model label still lands.
 */
export function schemeColor(scheme: ColorScheme, label: string): string | null {
  const norm = String(label).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const bucket = COLOR_SCHEMES[scheme].find((b) => b.label.toLowerCase() === norm);
  return bucket ? bucket.color : null;
}

/** Assign distinct highlight colours to an ordered list of open-ended topic groups (by order). */
export function assignTopicColors(groups: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const g of groups) {
    const key = g.trim().toLowerCase();
    if (!key || out.has(key)) continue;
    out.set(key, HIGHLIGHT_PALETTE[i % HIGHLIGHT_PALETTE.length]!.color);
    i += 1;
  }
  return out;
}

/**
 * Find the FIRST occurrence of `phrase` inside `text` and return its character range
 * `{ from, to }`, or `null` if not present. Case-insensitive by default; whitespace in the
 * phrase is matched flexibly (one-or-more spaces) so a model that re-spaces a phrase still
 * lands on the real text. Never returns a zero-width or out-of-bounds range.
 */
export function locatePhrase(text: string, phrase: string, opts: { caseInsensitive?: boolean } = {}): { from: number; to: number } | null {
  const ci = opts.caseInsensitive !== false;
  const needle = phrase.trim();
  if (!needle || !text) return null;
  // Fast path: exact substring.
  const direct = ci ? text.toLowerCase().indexOf(needle.toLowerCase()) : text.indexOf(needle);
  if (direct !== -1) return { from: direct, to: direct + needle.length };
  // Flexible-whitespace path.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  let re: RegExp; try { re = new RegExp(escaped, ci ? 'i' : ''); } catch { return null; }
  const m = re.exec(text);
  if (!m || m.index < 0 || m[0].length === 0) return null;
  return { from: m.index, to: m.index + m[0].length };
}
