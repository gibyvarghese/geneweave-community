// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the CREATIVE LAYER contract (weaveNotes Phase 1).
 *
 * Phase 0 fixed WHO did what (the agency-colour contract in `./agency`). Phase 1 adds the
 * playful surface a note can wear: the Pro ↔ Creative page theme, the multi-colour
 * highlighter, coloured text, callouts, toggles, stickers and washi dividers. This module is
 * the SINGLE SOURCE OF TRUTH for that creative vocabulary, as plain data + pure helpers (no
 * DOM, no framework) so the web editor, the AI co-author, and the public-share renderer all
 * agree on the exact tokens and can never drift. The hex values come from the geneWeave design
 * system (spec §10.2 / §10.6).
 *
 * --- For someone new to this ---
 * A note can open in one of two "outfits": **Pro** is the clean office look (white page, crisp
 * Plus Jakarta Sans title, soft highlighter); **Creative** is the cosy notebook look (warm paper,
 * handwritten Caveat title, a visible felt-tip underline highlight, and a ✨ sticker tool). Both
 * are the SAME note — only the styling changes. This file lists those two outfits, the four
 * highlighter colours, the kinds of callout (note / tip / warning…), and one careful colour
 * checker (`sanitizeColor`) that refuses anything that isn't plainly a colour — so a note can
 * never sneak code in through a "colour".
 */

import { AGENCY_PALETTE } from './agency.js';

/** A note's page theme. (The capability config's `NotesTheme` mirrors these two values app-side.) */
export type PageTheme = 'pro' | 'creative';
export const PAGE_THEMES: readonly PageTheme[] = ['pro', 'creative'] as const;

/** How a highlighter is painted in each theme (spec §10.6). */
export type HighlighterTreatment = 'soft-fill' | 'underline-gradient';

/** The resolved visual tokens for a page theme (spec §10.6 — surface, title font, highlighter, sticker tool). */
export interface PageThemeTokens {
  theme: PageTheme;
  /** Plain, user-facing label. */
  label: string;
  /** The page surface colour. */
  surface: string;
  /** The title font stack. */
  titleFont: string;
  /** Title size in px. */
  titleSizePx: number;
  /** Title font-weight. */
  titleWeight: number;
  /** How highlights are drawn in this theme. */
  highlighterTreatment: HighlighterTreatment;
  /** The soft-fill background used by the `soft-fill` treatment (Pro). */
  softFill: string;
  /** Whether the ✨ sticker tool is revealed in this theme (Creative only). */
  stickerTool: boolean;
}

/**
 * The two page themes, exactly per spec §10.6:
 *   Pro      → white #FFFFFF · Plus Jakarta Sans 34/800 · soft fill highlighter (#FCEFCF) · no sticker tool
 *   Creative → paper #FBF8F1 · Caveat 46/700 · visible underline highlight · ✨ sticker tool revealed
 */
export const PAGE_THEME_TOKENS: Record<PageTheme, PageThemeTokens> = {
  pro: {
    theme: 'pro', label: 'Pro',
    surface: AGENCY_PALETTE.surface,             // #FFFFFF
    titleFont: "'Plus Jakarta Sans', system-ui, sans-serif",
    titleSizePx: 34, titleWeight: 800,
    highlighterTreatment: 'soft-fill', softFill: '#FCEFCF',
    stickerTool: false,
  },
  creative: {
    theme: 'creative', label: 'Creative',
    surface: AGENCY_PALETTE.paper,               // #FBF8F1
    titleFont: "'Caveat', 'Comic Sans MS', cursive",
    titleSizePx: 46, titleWeight: 700,
    highlighterTreatment: 'underline-gradient', softFill: '#FCEFCF',
    stickerTool: true,
  },
};

/** Resolve a (possibly unknown) theme string to its tokens, defaulting to Pro. */
export function pageThemeTokens(theme: string | null | undefined): PageThemeTokens {
  return theme === 'creative' ? PAGE_THEME_TOKENS.creative : PAGE_THEME_TOKENS.pro;
}

/** Coerce any input to a valid page theme (defaults to 'pro'). */
export function coercePageTheme(v: unknown): PageTheme {
  return v === 'creative' ? 'creative' : 'pro';
}

// ─── Highlighter swatches (spec §10.2 / §10.6) ──────────────────────────────────────

export interface Swatch { key: string; label: string; color: string }

/** The four-colour highlighter set (the multi-colour highlighter the references show). */
export const HIGHLIGHTER_SWATCHES: readonly Swatch[] = [
  { key: 'amber', label: 'Amber', color: AGENCY_PALETTE.highlighters.amber }, // #FAC775
  { key: 'pink', label: 'Pink', color: AGENCY_PALETTE.highlighters.pink },   // #F4C0D1
  { key: 'teal', label: 'Teal', color: AGENCY_PALETTE.highlighters.teal },   // #9FE1CB
  { key: 'blue', label: 'Blue', color: AGENCY_PALETTE.highlighters.blue },   // #B5D4F4
] as const;

/** The default highlighter colour (the first swatch). */
export const DEFAULT_HIGHLIGHT = HIGHLIGHTER_SWATCHES[0]!.color;

// ─── Callout tones ──────────────────────────────────────────────────────────────────

export type CalloutTone = 'note' | 'tip' | 'warning' | 'success' | 'danger';

export interface CalloutToneSpec { tone: CalloutTone; label: string; icon: string; accent: string; surface: string }

/** The callout tones + their accent/surface tokens + a default icon (kept brand-aligned). */
export const CALLOUT_TONES: Record<CalloutTone, CalloutToneSpec> = {
  note: { tone: 'note', label: 'Note', icon: '📝', accent: AGENCY_PALETTE.muted, surface: AGENCY_PALETTE.canvas },
  tip: { tone: 'tip', label: 'Tip', icon: '💡', accent: AGENCY_PALETTE.emerald, surface: AGENCY_PALETTE.mint },
  warning: { tone: 'warning', label: 'Warning', icon: '⚠️', accent: AGENCY_PALETTE.amber, surface: '#FCF3E6' },
  success: { tone: 'success', label: 'Success', icon: '✅', accent: AGENCY_PALETTE.emerald, surface: AGENCY_PALETTE.mint },
  danger: { tone: 'danger', label: 'Danger', icon: '🚫', accent: AGENCY_PALETTE.coral, surface: AGENCY_PALETTE.dangerZone.bg },
};

/** Coerce any input to a known callout tone (defaults to 'note'). */
export function coerceCalloutTone(v: unknown): CalloutTone {
  return (typeof v === 'string' && v in CALLOUT_TONES) ? (v as CalloutTone) : 'note';
}

/** A small starter set of stickers the Creative-mode ✨ tool offers. */
export const STICKER_PRESETS: readonly string[] = ['✨', '⭐', '🔥', '💡', '✅', '❤️', '📌', '🎯', '🌱', '☕'] as const;

// ─── Colour safety (shared by editor, AI, and renderers) ────────────────────────────

// `sanitizeColor` now lives in the slim `@weaveintel/notes` colour-safety module (`./color-safety.js`).

/**
 * Is a highlighter colour an allowed swatch? The UI offers a fixed palette; the AI's
 * `apply_highlight` tool (Phase 2) should only colour with a known swatch so highlights stay
 * legible and on-brand. Comparison is case-insensitive.
 */
export function isKnownSwatch(color: string): boolean {
  const c = color.trim().toLowerCase();
  return HIGHLIGHTER_SWATCHES.some((s) => s.color.toLowerCase() === c);
}
