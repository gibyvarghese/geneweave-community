// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the "colour encodes agency" contract (weaveNotes Phase 0).
 *
 * One idea governs the whole weaveNotes UI: COLOUR SHOWS WHO DID WHAT. Anything the human
 * owns is rendered in calm neutrals (and their own hand-drawn ink is coral); anything the
 * AI is or created wears a soft emerald-mint signal with a woven mark and a byline. This is
 * not decoration — it is the visual contract that makes human↔AI co-editing legible at a
 * glance, so a person can scan a page and instantly see "I wrote this / the AI suggested that".
 *
 * This module is the SINGLE SOURCE OF TRUTH for that contract, as plain data + pure helpers
 * (no DOM, no framework), so web, desktop, and mobile all render authorship identically and
 * can never drift. The exact hex values come from the geneWeave design system (spec §10.2);
 * `@weaveintel/tokens` exposes the same palette as runtime theme tokens.
 *
 * --- For someone new to this ---
 * Think of a shared document where two people write in different coloured pens. Here one
 * "pen" is you (calm neutral / coral ink) and the other is the assistant (emerald-mint with
 * a little woven badge). You never have to guess who added what — the colour already tells you.
 */

/** Who authored a piece of content. */
export type Author = 'user' | 'ai' | 'human-ink';

/** The geneWeave palette (spec §10.2) — the exact hexes the agency contract is built from. */
export const AGENCY_PALETTE = {
  canvas: '#F6F8F7',       // app background (Pro)
  paper: '#FBF8F1',        // notes page surface (Creative)
  surface: '#FFFFFF',      // cards, panels, rails
  ink: '#14201B',          // primary text — what you own
  muted: '#5E6E67',        // secondary text, labels
  hairline: '#E7ECEA',     // borders, dividers
  emerald: '#0E9A6E',      // primary action + AI presence (ONLY)
  emeraldPress: '#0B7A57', // pressed/active; text on mint
  mint: '#E8F5EE',         // AI surfaces, agent bubbles, active rows
  mintDeep: '#DCEFE5',     // hover on mint; mint borders
  amber: '#D98A3D',        // attention only (overdue, unsaved) — sparing
  coral: '#D85A30',        // HUMAN ink / doodles
  /** Multi-colour highlighter set. */
  highlighters: { amber: '#FAC775', pink: '#F4C0D1', teal: '#9FE1CB', blue: '#B5D4F4' },
  /** Inline-diff colours for AI suggestions. */
  diffAdded: { bg: '#E8F5EE', fg: '#14201B' },
  diffRemoved: { bg: '#FBEFEA', fg: '#9C6B5C' },
  /** Demoted destructive surfaces. */
  dangerZone: { bg: '#FCF7F2', border: '#F0E0D5', fg: '#A8551F' },
  /** Reversed woven-mark strands (on dark). */
  reversed: { emerald: '#2FD39B', ink: '#E8EFEB' },
} as const;

/** The resolved visual style for a piece of content, by author. */
export interface AgencyStyle {
  author: Author;
  /** Surface/background token for the block. */
  surface: string;
  /** Foreground/text token. */
  foreground: string;
  /** Optional left-edge accent (AI blocks carry an emerald edge). */
  edge?: string;
  /** Whether to show the woven mark + byline (AI only). */
  showByline: boolean;
}

/**
 * Resolve the visual style for content by its author. This is the heart of the contract:
 *   - `user`      → neutral surface + ink text, no byline (calm, owned by you).
 *   - `ai`        → mint surface + emerald-press text + an emerald left edge + a byline.
 *   - `human-ink` → coral, the colour reserved for your hand-drawn strokes/doodles.
 */
export function authorStyle(author: Author): AgencyStyle {
  switch (author) {
    case 'ai':
      return { author, surface: AGENCY_PALETTE.mint, foreground: AGENCY_PALETTE.emeraldPress, edge: AGENCY_PALETTE.emerald, showByline: true };
    case 'human-ink':
      return { author, surface: AGENCY_PALETTE.paper, foreground: AGENCY_PALETTE.coral, showByline: false };
    case 'user':
    default:
      return { author: 'user', surface: AGENCY_PALETTE.surface, foreground: AGENCY_PALETTE.ink, showByline: false };
  }
}

/** The AI's byline prefix, and a helper to label an AI block by what it made. */
export const AI_BYLINE_PREFIX = 'geneWeave AI';
export function aiByline(kind?: string): string {
  const k = (kind ?? '').trim();
  return k ? `${AI_BYLINE_PREFIX} · ${k}` : AI_BYLINE_PREFIX;
}

/** Is this a colour the AI is permitted to use for its OWN presence? (emerald is reserved.) */
export function isAiSignalColor(hex: string): boolean {
  const h = hex.toLowerCase();
  return h === AGENCY_PALETTE.emerald.toLowerCase() || h === AGENCY_PALETTE.mint.toLowerCase() || h === AGENCY_PALETTE.emeraldPress.toLowerCase() || h === AGENCY_PALETTE.mintDeep.toLowerCase();
}

/**
 * The accessible, brand-aligned palette the AI may choose from when colour-coding content
 * (spec §4.4 "colour based on its knowledge"). Returns label→hex pairs that are all legible
 * on a light surface; the app should still validate any AI-chosen pair against the WCAG math
 * in `@weaveintel/tokens`. Reserved AI-signal colours (emerald/mint) are intentionally excluded
 * so the AI never colours USER content in the colour that means "this is the AI".
 */
export function aiContentPalette(): Array<{ label: string; hex: string }> {
  return [
    { label: 'amber', hex: AGENCY_PALETTE.highlighters.amber },
    { label: 'pink', hex: AGENCY_PALETTE.highlighters.pink },
    { label: 'teal', hex: AGENCY_PALETTE.highlighters.teal },
    { label: 'blue', hex: AGENCY_PALETTE.highlighters.blue },
    { label: 'coral', hex: AGENCY_PALETTE.coral },
    { label: 'amber-strong', hex: AGENCY_PALETTE.amber },
  ];
}
