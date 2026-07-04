// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { contrastRatio, meetsAA } from '@weaveintel/tokens';
import { validateDiagramScene, layoutDiagram, diagramToSvg } from './diagram.js';
import { READING_INK } from './colorize.js';

describe('diagram — validateDiagramScene', () => {
  it('keeps valid nodes + edges, resolves colours to safe pastels', () => {
    const scene = validateDiagramScene({
      kind: 'flow', title: 'Launch',
      nodes: [{ id: 'a', label: 'Plan', color: 'amber' }, { id: 'b', label: 'Build', color: 'teal' }, { id: 'c', label: 'Ship' }],
      edges: [{ from: 'a', to: 'b', label: 'then' }, { from: 'b', to: 'c' }],
    });
    expect(scene.kind).toBe('flow');
    expect(scene.nodes).toHaveLength(3);
    expect(scene.nodes[0]!.color).toBe('#FAC775'); // "amber" → swatch
    expect(scene.edges).toHaveLength(2);
  });
  it('drops dangling edges + self loops + dedupes ids', () => {
    const scene = validateDiagramScene({
      nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A2' }],
      edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }],
    });
    expect(scene.nodes.map((n) => n.id)).toEqual(['a', 'a_1']); // deduped
    expect(scene.edges).toHaveLength(0); // ghost + self-loop dropped
  });
  it('always returns ≥1 node, even from garbage', () => {
    expect(validateDiagramScene(null).nodes.length).toBeGreaterThanOrEqual(1);
    expect(validateDiagramScene({ nodes: 'oops' }).nodes.length).toBeGreaterThanOrEqual(1);
  });
  it('caps node + label sizes (anti-flood)', () => {
    const scene = validateDiagramScene({ nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, label: 'x'.repeat(500) })) });
    expect(scene.nodes.length).toBeLessThanOrEqual(60);
    expect(scene.nodes[0]!.label.length).toBeLessThanOrEqual(80);
  });
});

describe('diagram — layout', () => {
  it('ranks a linear flow left-to-right', () => {
    const scene = validateDiagramScene({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    const l = layoutDiagram(scene);
    const a = l.nodes.find((n) => n.id === 'a')!;
    const b = l.nodes.find((n) => n.id === 'b')!;
    const c = l.nodes.find((n) => n.id === 'c')!;
    expect(a.x).toBeLessThan(b.x); expect(b.x).toBeLessThan(c.x); // columns advance
    expect(l.width).toBeGreaterThan(0); expect(l.height).toBeGreaterThan(0);
  });
  it('handles a cycle without hanging', () => {
    const scene = validateDiagramScene({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    const l = layoutDiagram(scene);
    expect(l.nodes).toHaveLength(2);
  });
});

describe('diagram — diagramToSvg', () => {
  const scene = validateDiagramScene({
    title: 'Tides', kind: 'flow',
    nodes: [{ id: 'm', label: 'Moon', color: 'blue' }, { id: 't', label: 'Tide', color: 'teal', shape: 'diamond' }],
    edges: [{ from: 'm', to: 't', label: 'pulls' }],
  });
  it('renders a self-contained SVG with nodes, an arrow, + the title', () => {
    const svg = diagramToSvg(scene);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Moon'); expect(svg).toContain('Tide');
    expect(svg).toContain('marker-end="url(#gw-arrow)"');
    expect(svg).toContain('<polygon'); // the diamond
    expect(svg).toContain('Tides'); // the title
  });
  it('SKETCH style: renders hand-drawn (wobbly path borders + a handwriting label font), deterministically', () => {
    const sk1 = diagramToSvg(scene, { style: 'sketch' });
    const sk2 = diagramToSvg(scene, { style: 'sketch' });
    expect(sk1.startsWith('<svg')).toBe(true);
    expect(sk1).toContain('class="gw-diagram sketch"');
    expect(sk1).toContain('Caveat');                 // handwriting label font
    expect(sk1).toContain('Q ');                      // wobbly quadratic strokes (Rough.js-style)
    expect(sk1).toContain('Moon'); expect(sk1).toContain('Tide');
    expect(sk1).toBe(sk2);                            // deterministic (seeded) — same input → same SVG
    // The default (clean) style is unchanged.
    expect(diagramToSvg(scene)).toContain('class="gw-diagram"');
    expect(diagramToSvg(scene)).not.toContain('Caveat');
  });
  it('SKETCH style: a hostile label/colour is still safe (no script/CSS injection)', () => {
    const svg = diagramToSvg(validateDiagramScene({ nodes: [{ id: 'x', label: '</text><script>alert(1)</script>', color: 'red;}body{}' }], edges: [] }), { style: 'sketch' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });
  it('renders process/business shapes (cylinder, parallelogram, hexagon)', () => {
    const svg = diagramToSvg(validateDiagramScene({
      nodes: [{ id: 'db', label: 'Store', shape: 'cylinder' }, { id: 'io', label: 'Input', shape: 'parallelogram' }, { id: 'pre', label: 'Prep', shape: 'hexagon' }],
      edges: [{ from: 'io', to: 'pre' }, { from: 'pre', to: 'db' }],
    }));
    expect(svg).toContain('<polygon'); // parallelogram / hexagon
    expect(svg).toContain('A '); // cylinder arc path
  });
  it('SECURITY: a hostile label/colour cannot inject script or CSS', () => {
    const svg = diagramToSvg(validateDiagramScene({
      nodes: [{ id: 'x', label: '</text><script>alert(1)</script>', color: 'red;}body{}' }],
      edges: [],
    }));
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('url(j');
    expect(svg).toContain('&lt;'); // escaped
  });
  it('ACCESSIBILITY: dark reading ink stays AA on every node fill the renderer picks', () => {
    // The renderer resolves node colours to the WCAG-AA highlight palette; prove ink-on-fill is AA.
    const big = validateDiagramScene({ nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), edges: [] });
    for (const n of big.nodes) {
      expect(meetsAA(contrastRatio(READING_INK, n.color!)), `ink on ${n.color}`).toBe(true);
    }
  });
});
