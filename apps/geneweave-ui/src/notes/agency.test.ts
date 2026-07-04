// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { AGENCY_PALETTE, authorStyle, aiByline, isAiSignalColor, aiContentPalette } from './agency.js';

describe('agency-colour contract', () => {
  it('user content is neutral with no byline; AI content is mint + emerald edge + byline; human ink is coral', () => {
    expect(authorStyle('user')).toMatchObject({ surface: AGENCY_PALETTE.surface, foreground: AGENCY_PALETTE.ink, showByline: false });
    const ai = authorStyle('ai');
    expect(ai).toMatchObject({ surface: AGENCY_PALETTE.mint, foreground: AGENCY_PALETTE.emeraldPress, edge: AGENCY_PALETTE.emerald, showByline: true });
    expect(authorStyle('human-ink').foreground).toBe(AGENCY_PALETTE.coral);
  });
  it('byline labels the AI block by what it made', () => {
    expect(aiByline()).toBe('geneWeave AI');
    expect(aiByline('mind map')).toBe('geneWeave AI · mind map');
    expect(aiByline('  ')).toBe('geneWeave AI'); // blank kind ignored
  });
  it('emerald/mint are reserved AI-signal colours; the AI palette excludes them (so it never paints user content "AI")', () => {
    expect(isAiSignalColor(AGENCY_PALETTE.emerald)).toBe(true);
    expect(isAiSignalColor('#0E9A6E'.toUpperCase())).toBe(true); // case-insensitive
    expect(isAiSignalColor(AGENCY_PALETTE.coral)).toBe(false);
    const palette = aiContentPalette().map((c) => c.hex.toLowerCase());
    expect(palette).not.toContain(AGENCY_PALETTE.emerald.toLowerCase());
    expect(palette).not.toContain(AGENCY_PALETTE.mint.toLowerCase());
  });
});
