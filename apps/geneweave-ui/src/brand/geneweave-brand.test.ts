// SPDX-License-Identifier: MIT
/**
 * The geneWeave BRAND, composed on the neutral @weaveintel/tokens engine. These assertions used to live
 * in the tokens package (when it WAS the geneWeave brand); after the engine/brand split they belong with
 * the app that owns the look. They pin the brand values + verify the brand is WCAG-AA accessible.
 */
import { describe, it, expect } from 'vitest';
import { auditThemeContrast } from '@weaveintel/tokens';
import { geneweaveThemes, geneweaveThemeCss, geneweaveFonts, GENEWEAVE_CSS_PREFIX } from './geneweave-brand.js';

describe('geneWeave brand — palette + fonts', () => {
  it('keeps the emerald identity (light canvas + emerald accent, dark green-black)', () => {
    expect(geneweaveThemes.light.colors.background).toBe('#F6F8F7'); // canvas
    expect(geneweaveThemes.light.colors.accent).toBe('#0E9A6E');     // emerald (AI + primary)
    expect(geneweaveThemes.light.colors.mint).toBe('#E8F5EE');       // AI surface
    expect(geneweaveThemes.dark.colors.background).toBe('#0E1714');  // deep green-black
  });
  it('uses the geneWeave fonts (Plus Jakarta Sans / Inter / JetBrains Mono / Caveat)', () => {
    expect(geneweaveFonts).toEqual({ display: 'Plus Jakarta Sans', body: 'Inter', mono: 'JetBrains Mono', hand: 'Caveat' });
    expect(GENEWEAVE_CSS_PREFIX).toBe('gw');
  });
});

describe('geneWeave brand — is accessible (WCAG-AA) on the engine audit', () => {
  it('every text-on-surface pair passes AA in BOTH themes', () => {
    expect(auditThemeContrast(geneweaveThemes.light).pass).toBe(true);
    expect(auditThemeContrast(geneweaveThemes.dark).pass).toBe(true);
  });
});

describe('geneWeave brand — the web stylesheet (--gw-* on the engine transform)', () => {
  const css = geneweaveThemeCss();
  it('emits the emerald palette under the --gw-* prefix', () => {
    expect(css).toContain('--gw-color-background: #F6F8F7');
    expect(css).toContain('--gw-color-accent: #0E9A6E');
    expect(css).toContain('--gw-font-display: Plus Jakarta Sans, sans-serif');
  });
  it('writes light on :root, dark on [data-theme=dark], and the Creative page/title swap', () => {
    expect(css).toContain(':root {');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-variant="creative"]');
    expect(css).toContain('--gw-page: var(--gw-color-paper)');       // creative → warm paper
    expect(css).toContain('--gw-font-title: var(--gw-font-hand)');   // creative → handwriting
    expect(css).toContain('--gw-ai-surface: var(--gw-color-mint)');  // agency stays mint in both modes
  });
  it('includes breakpoint tokens and legacy aliases by default', () => {
    expect(css).toContain('--gw-bp-tablet: 900px');
    expect(css).toContain('--accent: var(--gw-color-accent)');
    expect(css).toContain('--bg: var(--gw-color-background)');
  });
  it('can omit legacy aliases', () => {
    expect(geneweaveThemeCss({ legacy: false })).not.toContain('--bg: var(--gw-color-background)');
  });
});
