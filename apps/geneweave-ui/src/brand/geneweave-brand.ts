// SPDX-License-Identifier: MIT
/**
 * geneweave-brand.ts — the geneWeave BRAND, composed on the brand-neutral
 * `@weaveintel/tokens` theming engine.
 *
 * The restructure split `@weaveintel/tokens` into two clean halves:
 *   • the ENGINE (`@weaveintel/tokens`) — the machinery: the token schema/types, the
 *     colour maths (`contrastRatio`/`meetsAA`), the CSS transform (`toCssVariables`), the
 *     per-tenant white-label functions, and the generic scales (spacing, radii, type scale,
 *     motion, breakpoints, elevation). It takes a palette as INPUT and is not tied to any brand.
 *   • the BRAND (this file, app-owned) — the geneWeave VALUES: the emerald palette, the
 *     Plus Jakarta Sans / Inter / JetBrains Mono / Caveat fonts, the assembled dark/light
 *     themes, and the `--gw-*` CSS variable names + the "colour encodes agency" web tokens.
 *
 * So the app supplies its identity and the framework supplies the mechanism — nothing about
 * "geneWeave" leaks into the published package. (In the private commercial repo this becomes a
 * shared `@geneweave/brand`; here it lives with the web app that owns the look.)
 */
import {
  toCssVariables,
  typography as neutralTypography,
  spacing,
  radii,
  darkElevation,
  lightElevation,
  motion,
  breakpoints,
  type Theme,
  type ColorTokens,
  type FontFamilies,
  type TypographyTokens,
} from '@weaveintel/tokens';

/** The geneWeave CSS custom-property prefix (`--gw-*`). This name is BRAND, not engine. */
export const GENEWEAVE_CSS_PREFIX = 'gw';

// ── The geneWeave palette (deep green-black + emerald; "colour encodes agency"). ─────────────

/** Canonical dark brand palette — geneWeave dark (deep green-black + bright emerald). */
export const geneweaveDark: ColorTokens = {
  background: '#0E1714',
  surface: '#15201C',
  surfaceElevated: '#1B2723',
  border: '#2A3833',

  text: '#E8EFEB',
  textSecondary: '#AEC2B9',
  textMuted: '#9DB3A9',

  accent: '#2FD39B',        // reversed-emerald (large/decorative on dark)
  accentStrong: '#3FE0A8',  // bright — normal text on dark surfaces
  accentSoft: '#16332A',    // mint, dark
  onAccent: '#06120D',      // dark ink on a bright accent fill

  danger: '#F08A60',
  success: '#3FE0A8',
  warning: '#E0A87F',

  paper: '#141E18',
  mint: '#16332A',
  mintDeep: '#1C3F33',
  coral: '#F08A60',
  amber: '#E0A87F',
  hlAmber: '#FAC775', hlPink: '#F4C0D1', hlTeal: '#9FE1CB', hlBlue: '#B5D4F4',
  diffAddedBg: '#16332A', diffRemovedBg: '#3A201A', diffRemovedFg: '#D4A595',
  dangerZoneBg: '#241A14', dangerZoneBorder: '#3A2A1E', dangerZoneFg: '#E0A87F',
};

/** geneWeave light palette (the canonical weaveNotes surface). AA-verified. */
export const geneweaveLight: ColorTokens = {
  background: '#F6F8F7',     // canvas
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  border: '#E7ECEA',         // hairline

  text: '#14201B',           // ink
  textSecondary: '#5E6E67',  // muted
  textMuted: '#5E6E67',      // muted (large-text use)

  accent: '#0E9A6E',         // emerald (large/decorative + AI presence)
  accentStrong: '#0B7A57',   // emerald-press (normal text + on-mint text)
  accentSoft: '#E8F5EE',     // mint
  onAccent: '#FFFFFF',

  danger: '#B91C1C',
  success: '#15803D',
  warning: '#B45309',

  paper: '#FBF8F1',
  mint: '#E8F5EE',
  mintDeep: '#DCEFE5',
  coral: '#D85A30',
  amber: '#D98A3D',
  hlAmber: '#FAC775', hlPink: '#F4C0D1', hlTeal: '#9FE1CB', hlBlue: '#B5D4F4',
  diffAddedBg: '#E8F5EE', diffRemovedBg: '#FBEFEA', diffRemovedFg: '#9C6B5C',
  dangerZoneBg: '#FCF7F2', dangerZoneBorder: '#F0E0D5', dangerZoneFg: '#A8551F',
};

// ── The geneWeave fonts (names only; the native app loads the faces). ────────────────────────

/** geneWeave type families: Plus Jakarta Sans / Inter / JetBrains Mono / Caveat (Creative). */
export const geneweaveFonts: FontFamilies = {
  display: 'Plus Jakarta Sans',
  body: 'Inter',
  mono: 'JetBrains Mono',
  hand: 'Caveat',
};

/** geneWeave typography = the engine's neutral type SCALE + weights, with the brand FONTS. */
export const geneweaveTypography: TypographyTokens = {
  ...neutralTypography,
  families: geneweaveFonts,
};

// ── The assembled geneWeave themes (palette + fonts + the engine's generic scales). ──────────

/** The two geneWeave base themes — the app's `themes`, built on the engine. */
export const geneweaveThemes: Readonly<Record<'dark' | 'light', Theme>> = {
  dark: {
    name: 'dark',
    colors: geneweaveDark,
    typography: geneweaveTypography,
    spacing,
    radii,
    elevation: darkElevation,
    motion,
  },
  light: {
    name: 'light',
    colors: geneweaveLight,
    typography: geneweaveTypography,
    spacing,
    radii,
    elevation: lightElevation,
    motion,
  },
};

// ── The geneWeave web stylesheet (`--gw-*` + agency + Pro/Creative + legacy aliases). ────────

function block(selector: string, vars: Record<string, string>, indent = '  '): string {
  const body = Object.entries(vars).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}`;
}

/** Legacy `--bg`/`--accent`/… aliases so the existing web stylesheet keeps working while it migrates. */
function legacyAliases(): Record<string, string> {
  return {
    '--canvas': 'var(--gw-color-background)',
    '--surface': 'var(--gw-color-surface)',
    '--paper': 'var(--gw-color-paper)',
    '--ink': 'var(--gw-color-text)',
    '--muted': 'var(--gw-color-text-secondary)',
    '--hairline': 'var(--gw-color-border)',
    '--bg': 'var(--gw-color-background)',
    '--bg2': 'var(--gw-color-surface)',
    '--bg3': 'var(--gw-color-mint)',
    '--bg4': 'var(--gw-color-border)',
    '--fg': 'var(--gw-color-text)',
    '--fg2': 'var(--gw-color-text-secondary)',
    '--fg3': 'var(--gw-color-text-muted)',
    '--accent': 'var(--gw-color-accent)',
    '--accent2': 'var(--gw-color-accent-strong)',
    '--accent-dim': 'var(--gw-color-mint)',
    '--mint': 'var(--gw-color-mint)',
    '--mint-deep': 'var(--gw-color-mint-deep)',
    '--amber': 'var(--gw-color-amber)',
    '--coral': 'var(--gw-color-coral)',
    '--hl-amber': 'var(--gw-color-hl-amber)',
    '--hl-pink': 'var(--gw-color-hl-pink)',
    '--hl-teal': 'var(--gw-color-hl-teal)',
    '--hl-blue': 'var(--gw-color-hl-blue)',
    '--font': 'var(--gw-font-body)',
    '--font-display': 'var(--gw-font-display)',
    '--mono': 'var(--gw-font-mono)',
    '--radius': 'var(--gw-radius-md)',
    '--radius-lg': 'var(--gw-radius-lg)',
  };
}

export interface GeneweaveThemeCssOptions {
  /** Emit legacy `--bg`/`--accent`/… aliases (default true) so an existing stylesheet migrates gradually. */
  legacy?: boolean;
  /** Selector the light theme is written to (default ':root'). */
  rootSelector?: string;
}

/**
 * The full geneWeave web token stylesheet: light on :root, dark on `[data-theme="dark"]`, the Creative
 * page/title swap on `[data-variant="creative"]`, plus breakpoint + "colour encodes agency" component
 * tokens. Built on the engine's generic `toCssVariables(theme, { prefix: 'gw' })`; the geneWeave-specific
 * structure (agency tokens, Pro/Creative flip, legacy aliases) lives here in the app, not the framework.
 */
export function geneweaveThemeCss(opts: GeneweaveThemeCssOptions = {}): string {
  const root = opts.rootSelector ?? ':root';
  const legacy = opts.legacy !== false;
  const vars = (t: Theme) => toCssVariables(t, { prefix: GENEWEAVE_CSS_PREFIX });

  // Page + title tokens make Pro/Creative a token flip, not a fork: page = surface (pro) / paper (creative),
  // title font = display (pro) / handwriting (creative). AI surfaces stay mint in BOTH.
  const proExtras: Record<string, string> = {
    '--gw-page': 'var(--gw-color-surface)',
    '--gw-font-title': 'var(--gw-font-display)',
    '--gw-ai-surface': 'var(--gw-color-mint)',
    '--gw-ai-border': 'var(--gw-color-mint-deep)',
    '--gw-ai-signal': 'var(--gw-color-accent)',
    '--gw-bp-foldable': `${breakpoints.foldable}px`,
    '--gw-bp-tablet': `${breakpoints.tablet}px`,
    '--gw-bp-desktop': `${breakpoints.desktop}px`,
    '--gw-bp-wide': `${breakpoints.wide}px`,
  };

  const lightVars = { ...vars(geneweaveThemes.light), ...proExtras, ...(legacy ? legacyAliases() : {}) };
  const darkVars = vars(geneweaveThemes.dark);

  const parts = [
    '/* geneWeave design tokens — generated from @weaveintel/tokens (the brand-neutral engine) + the geneWeave brand. Do not edit by hand. */',
    block(root, lightVars),
    block(`${root}[data-theme="dark"], [data-theme="dark"]`, darkVars),
    block('[data-variant="creative"]', {
      '--gw-page': 'var(--gw-color-paper)',
      '--gw-font-title': 'var(--gw-font-hand)',
    }),
    block('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])', darkVars, '    ') + '\n}',
  ];
  return parts.join('\n\n');
}
