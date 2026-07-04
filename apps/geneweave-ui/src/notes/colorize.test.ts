// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { contrastRatio, meetsAA } from '@weaveintel/tokens';
import {
  HIGHLIGHT_PALETTE, TEXT_COLOR_PALETTE, COLOR_SCHEMES, READING_INK,
  isColorScheme, schemeLabels, schemeColor, assignTopicColors, locatePhrase,
} from './colorize.js';

const WHITE = '#FFFFFF';  // Pro page surface
const PAPER = '#FBF8F1';  // Creative page surface

describe('colorize — the palette is provably WCAG-AA (the @weaveintel/tokens contrast maths)', () => {
  it('reading ink stays AA on EVERY highlight background', () => {
    for (const { label, color } of HIGHLIGHT_PALETTE) {
      const ratio = contrastRatio(READING_INK, color);
      expect(meetsAA(ratio), `ink on highlight "${label}" (${color}) = ${ratio.toFixed(2)}:1`).toBe(true);
    }
  });

  it('every text colour stays AA on BOTH the Pro white page and the Creative paper', () => {
    for (const { label, color } of TEXT_COLOR_PALETTE) {
      const onWhite = contrastRatio(color, WHITE);
      const onPaper = contrastRatio(color, PAPER);
      expect(meetsAA(onWhite), `text "${label}" (${color}) on white = ${onWhite.toFixed(2)}:1`).toBe(true);
      expect(meetsAA(onPaper), `text "${label}" (${color}) on paper = ${onPaper.toFixed(2)}:1`).toBe(true);
    }
  });

  it('every scheme bucket colour is itself AA under the reading ink', () => {
    for (const scheme of Object.keys(COLOR_SCHEMES) as Array<keyof typeof COLOR_SCHEMES>) {
      for (const bucket of COLOR_SCHEMES[scheme]) {
        expect(meetsAA(contrastRatio(READING_INK, bucket.color)), `${scheme}/${bucket.label} ${bucket.color}`).toBe(true);
      }
    }
  });
});

describe('colorize — schemes', () => {
  it('recognises the four schemes and rejects junk', () => {
    expect(isColorScheme('topic')).toBe(true);
    expect(isColorScheme('importance')).toBe(true);
    expect(isColorScheme('rainbow')).toBe(false);
    expect(isColorScheme(null)).toBe(false);
  });

  it('exposes the allowed labels the AI may use', () => {
    expect(schemeLabels('status')).toEqual(['done', 'in_progress', 'blocked', 'todo']);
    expect(schemeLabels('sentiment')).toEqual(['positive', 'neutral', 'negative']);
    expect(schemeLabels('topic').length).toBe(8);
  });

  it('maps a label to a colour, tolerant of case/spacing/hyphens', () => {
    expect(schemeColor('status', 'done')).toBe('#9FE1CB');
    expect(schemeColor('status', 'In Progress')).toBe('#FAC775'); // spaced + cased
    expect(schemeColor('status', 'in-progress')).toBe('#FAC775'); // hyphenated
    expect(schemeColor('importance', 'critical')).toBe('#F4C0D1');
    expect(schemeColor('status', 'nonsense')).toBeNull();
  });

  it('assigns distinct topic colours by order, skipping blanks + dupes', () => {
    const m = assignTopicColors(['Tides', 'Weather', 'Tides', '', 'Budget']);
    expect(m.size).toBe(3);
    expect(m.get('tides')).toBe('#FAC775');
    expect(m.get('weather')).toBe('#F4C0D1');
    expect(m.get('budget')).toBe('#9FE1CB');
  });

  it('cycles colours when there are more topics than swatches', () => {
    const groups = Array.from({ length: 10 }, (_, i) => `g${i}`);
    const m = assignTopicColors(groups);
    expect(m.size).toBe(10);
    expect(m.get('g0')).toBe(m.get('g8')); // wrapped around 8-colour palette
  });
});

describe('colorize — locatePhrase', () => {
  const text = 'The Moon dominates the tides, and Spring tides are the largest.';
  it('finds an exact phrase (case-insensitive)', () => {
    expect(locatePhrase(text, 'Moon')).toEqual({ from: 4, to: 8 });
    expect(locatePhrase(text, 'moon')).toEqual({ from: 4, to: 8 });
    expect(locatePhrase(text, 'spring tides')).toEqual({ from: 34, to: 46 });
  });
  it('matches flexible whitespace', () => {
    expect(locatePhrase('a   b', 'a b')).toEqual({ from: 0, to: 5 });
  });
  it('returns null for an absent phrase / empty inputs', () => {
    expect(locatePhrase(text, 'volcano')).toBeNull();
    expect(locatePhrase('', 'x')).toBeNull();
    expect(locatePhrase(text, '   ')).toBeNull();
  });
  it('SECURITY/STRESS: a regex-special or huge phrase never throws + never returns a bad range', () => {
    const hostile = ['(((', '.*', '[a-z', '\\', '$^', 'a'.repeat(5000)];
    for (const h of hostile) {
      const r = locatePhrase(text, h);
      if (r !== null) { expect(r.from).toBeGreaterThanOrEqual(0); expect(r.to).toBeGreaterThan(r.from); expect(r.to).toBeLessThanOrEqual(text.length); }
    }
    // a literal regex-special substring is still found literally
    expect(locatePhrase('cost is $5 (cheap)', '$5')).toEqual({ from: 8, to: 10 });
  });
});
