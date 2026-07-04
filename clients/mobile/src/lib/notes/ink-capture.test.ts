/**
 * ink-capture.test.ts — Node unit tests for the pure ink-capture maths.
 */
import { describe, it, expect } from 'vitest';
import {
  beginStroke, extendStroke, endStroke, commitStroke, undoStroke, strokePath,
  DEFAULT_PEN, HIGHLIGHTER_PEN,
} from './ink-capture.js';
import { validateStrokes } from '@weaveintel/notes';

describe('ink-capture — building a stroke from touch points', () => {
  it('begins, extends, and ends a stroke with the active pen', () => {
    let s = beginStroke({ x: 0, y: 0 }, DEFAULT_PEN);
    s = extendStroke(s, { x: 10, y: 10 });
    s = extendStroke(s, { x: 20, y: 5 });
    expect(s.color).toBe(DEFAULT_PEN.color);
    expect(s.tool).toBe('pen');
    expect(s.author).toBe('user');
    const done = endStroke(s);
    expect(done).not.toBeNull();
    expect(done!.points).toHaveLength(3);
  });

  it('dedupes a point identical to the previous one (finger held still)', () => {
    let s = beginStroke({ x: 1, y: 1 }, DEFAULT_PEN);
    s = extendStroke(s, { x: 1, y: 1 }); // duplicate
    s = extendStroke(s, { x: 2, y: 2 });
    expect(s.points).toHaveLength(2);
  });

  it('drops a tap (a single-point "stroke") so stray taps are not persisted', () => {
    const s = beginStroke({ x: 5, y: 5 }, DEFAULT_PEN);
    expect(endStroke(s)).toBeNull();
  });

  it('the highlighter pen produces a wider highlighter stroke', () => {
    let s = beginStroke({ x: 0, y: 0 }, HIGHLIGHTER_PEN);
    s = extendStroke(s, { x: 30, y: 0 });
    const done = endStroke(s)!;
    expect(done.tool).toBe('highlighter');
    expect(done.width).toBe(HIGHLIGHTER_PEN.width);
  });

  it('commitStroke appends + re-validates; undoStroke removes the last', () => {
    let strokes = validateStrokes([]);
    let a = beginStroke({ x: 0, y: 0 }, DEFAULT_PEN); a = extendStroke(a, { x: 5, y: 5 });
    strokes = commitStroke(strokes, endStroke(a));
    let b = beginStroke({ x: 9, y: 9 }, DEFAULT_PEN); b = extendStroke(b, { x: 1, y: 1 });
    strokes = commitStroke(strokes, endStroke(b));
    expect(strokes).toHaveLength(2);
    expect(undoStroke(strokes)).toHaveLength(1);
    expect(commitStroke(strokes, null)).toHaveLength(2); // null (a tap) is a no-op
  });

  it('strokePath renders an SVG path string starting with a Move command', () => {
    let s = beginStroke({ x: 0, y: 0 }, DEFAULT_PEN);
    s = extendStroke(s, { x: 10, y: 10 });
    const d = strokePath(s);
    expect(typeof d).toBe('string');
    expect(d.startsWith('M')).toBe(true);
  });

  it('SECURITY/STRESS: a flood of points stays bounded + finite after validation', () => {
    let s = beginStroke({ x: 0, y: 0 }, DEFAULT_PEN);
    for (let i = 0; i < 10_000; i++) s = extendStroke(s, { x: i % 300, y: (i * 7) % 300 });
    const done = endStroke(s)!;
    expect(done.points.length).toBeLessThanOrEqual(4000); // package gate caps points
    expect(done.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
