// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the native DIAGRAM model + renderer (weaveNotes Phase 4).
 *
 * "Sketch a colour-coded flow of these 4 steps" should give you a real, editable, intentionally
 * coloured diagram — not a flat picture. The mid-2026 way an LLM makes a diagram is to emit
 * STRUCTURED JSON (nodes + edges), which a renderer lays out and draws. So a weaveNotes diagram
 * is just that data: a list of labelled, coloured nodes and the edges between them. It stays
 * native + editable (you can recolour a node, change a label, add an edge) and is the SAME shape
 * whether a human or the AI made it — no AI-specific format.
 *
 * This module owns that model + how it becomes a picture, all pure + zero-dependency:
 *   - `validateDiagramScene` — the strict gate over a (possibly AI- or client-supplied) scene:
 *     cap node/edge counts, dedupe ids, cap label lengths, resolve every colour to a
 *     PRE-VALIDATED WCAG-AA pastel (so dark text on a node is always legible), drop dangling edges;
 *   - `layoutDiagram` — a dependency-free LAYERED left-to-right layout (rank by BFS depth), which
 *     handles flows, trees/mind-maps, and small graphs;
 *   - `diagramToSvg` — render the laid-out scene to a self-contained `<svg>` with rounded nodes,
 *     arrowed edges, and centred labels (for the editor, a share, and the exported artifact).
 */
import { HIGHLIGHT_PALETTE, READING_INK } from './colorize.js';
import { sanitizeColor } from '@weaveintel/notes';

export type DiagramKind = 'flow' | 'mindmap' | 'graph';
/** Node shapes — process/business/block-diagram vocabulary. */
export type NodeShape = 'box' | 'pill' | 'diamond' | 'ellipse' | 'cylinder' | 'parallelogram' | 'hexagon';

/** A diagram node: a labelled, coloured shape. `color` is a swatch label or hex (validated to a safe pastel). */
export interface DiagramNode { id: string; label: string; color?: string; shape?: NodeShape }
/** A directed edge between two node ids, optionally labelled/coloured. */
export interface DiagramEdge { from: string; to: string; label?: string; color?: string }
/** A whole diagram scene (the node data stored in the `diagram` block). */
export interface DiagramScene { kind?: DiagramKind; title?: string; nodes: DiagramNode[]; edges: DiagramEdge[] }

const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_LABEL = 80;

/** Resolve a colour intent (swatch label / hex) to a PRE-VALIDATED WCAG-AA pastel fill. */
function nodeFill(color: string | undefined, index: number): string {
  if (color) {
    const byLabel = HIGHLIGHT_PALETTE.find((p) => p.label === String(color).trim().toLowerCase());
    if (byLabel) return byLabel.color;
    const hex = sanitizeColor(color);
    // Accept a client hex only if it's a light pastel (so the dark label stays legible); else fall back.
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum >= 0.6) return hex;
    }
  }
  return HIGHLIGHT_PALETTE[index % HIGHLIGHT_PALETTE.length]!.color;
}

/** A slightly darker stroke for a fill colour (a fixed darken, deterministic). */
function darken(hex: string, amount = 0.35): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return READING_INK;
  const f = (i: number): string => {
    const v = Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount));
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  };
  return `#${f(1)}${f(3)}${f(5)}`;
}

/**
 * Validate + normalise a (possibly hostile) scene: cap counts, dedupe + slug ids, cap labels,
 * resolve every node colour to a safe WCAG-AA pastel, keep only a known shape, and DROP any edge
 * whose endpoints aren't real nodes. Always returns a renderable scene (≥1 node).
 */
export function validateDiagramScene(input: unknown): DiagramScene {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind: DiagramKind = s['kind'] === 'mindmap' || s['kind'] === 'graph' ? s['kind'] : 'flow';
  const title = typeof s['title'] === 'string' ? s['title'].slice(0, MAX_LABEL) : undefined;

  const rawNodes = Array.isArray(s['nodes']) ? (s['nodes'] as unknown[]).slice(0, MAX_NODES) : [];
  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  let auto = 0;
  for (const rn of rawNodes) {
    if (!rn || typeof rn !== 'object') continue;
    const n = rn as Record<string, unknown>;
    let id = typeof n['id'] === 'string' && n['id'].trim() ? n['id'].trim().slice(0, 64) : `n${auto}`;
    while (ids.has(id)) id = `${id}_${auto}`;
    ids.add(id); auto += 1;
    const label = typeof n['label'] === 'string' ? n['label'].slice(0, MAX_LABEL) : (typeof n['text'] === 'string' ? (n['text'] as string).slice(0, MAX_LABEL) : id);
    const SHAPES: NodeShape[] = ['box', 'pill', 'diamond', 'ellipse', 'cylinder', 'parallelogram', 'hexagon'];
    const shape: NodeShape = SHAPES.includes(n['shape'] as NodeShape) ? n['shape'] as NodeShape : 'box';
    nodes.push({ id, label, color: nodeFill(typeof n['color'] === 'string' ? n['color'] : undefined, nodes.length), shape });
  }
  if (nodes.length === 0) nodes.push({ id: 'n0', label: title ?? 'Diagram', color: HIGHLIGHT_PALETTE[0]!.color, shape: 'box' });

  const rawEdges = Array.isArray(s['edges']) ? (s['edges'] as unknown[]).slice(0, MAX_EDGES) : [];
  const edges: DiagramEdge[] = [];
  for (const re of rawEdges) {
    if (!re || typeof re !== 'object') continue;
    const e = re as Record<string, unknown>;
    const from = String(e['from'] ?? ''); const to = String(e['to'] ?? '');
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    edges.push({ from, to, ...(typeof e['label'] === 'string' ? { label: e['label'].slice(0, MAX_LABEL) } : {}), ...(typeof e['color'] === 'string' && sanitizeColor(e['color']) ? { color: sanitizeColor(e['color'])! } : {}) });
  }
  return { kind, ...(title ? { title } : {}), nodes, edges };
}

// ─── Layout ─────────────────────────────────────────────────────────────────────────────

export interface PlacedNode extends DiagramNode { x: number; y: number; w: number; h: number }
export interface DiagramLayout { nodes: PlacedNode[]; width: number; height: number; titleH: number }

const NODE_H = 46;
const GAP_X = 64;
const GAP_Y = 22;
const MARGIN = 16;

function nodeWidth(label: string): number { return Math.max(84, Math.min(220, label.length * 8 + 28)); }

/** Assign each node a position via a layered left-to-right layout (rank = BFS depth from roots). */
export function layoutDiagram(scene: DiagramScene): DiagramLayout {
  const { nodes, edges } = scene;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue; // skip dangling edges (layout may get a raw scene)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }

  // Rank by BFS from the roots (in-degree 0); nodes never reached get the next rank.
  const rank = new Map<string, number>();
  let queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (queue.length === 0 && nodes.length) queue = [nodes[0]!.id];
  for (const id of queue) rank.set(id, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!; const r = rank.get(id) ?? 0;
    for (const to of adj.get(id) ?? []) { if (!rank.has(to)) { rank.set(to, r + 1); queue.push(to); } }
  }
  let maxRank = 0;
  for (const n of nodes) { if (!rank.has(n.id)) rank.set(n.id, maxRank + 1); maxRank = Math.max(maxRank, rank.get(n.id)!); }

  // Group by rank, place columns left→right, stack within a column.
  const cols = new Map<number, string[]>();
  for (const n of nodes) { const r = rank.get(n.id)!; (cols.get(r) ?? cols.set(r, []).get(r)!).push(n.id); }
  const titleH = scene.title ? 28 : 0;
  const placed: PlacedNode[] = [];
  let x = MARGIN;
  let maxColH = 0;
  const sortedRanks = [...cols.keys()].sort((a, b) => a - b);
  const colWidths: number[] = [];
  for (const r of sortedRanks) {
    const ids = cols.get(r)!;
    const colW = Math.max(...ids.map((id) => nodeWidth(byId.get(id)!.label)));
    colWidths.push(colW);
    let y = MARGIN + titleH;
    for (const id of ids) {
      const n = byId.get(id)!;
      placed.push({ ...n, x, y, w: colW, h: NODE_H });
      y += NODE_H + GAP_Y;
    }
    maxColH = Math.max(maxColH, y - GAP_Y);
    x += colW + GAP_X;
  }
  const width = x - GAP_X + MARGIN;
  const height = maxColH + MARGIN;
  return { nodes: placed, width: Math.max(width, 160), height: Math.max(height, 80), titleH };
}

// ─── Render ─────────────────────────────────────────────────────────────────────────────

const SVG_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => SVG_ESC[c]!); }

// ─── Hand-drawn ("sketch") rendering — a self-contained, dependency-free take on Rough.js ─────────
// Notes can render diagrams in a clean style OR a HAND-DRAWN style (wobbly strokes + a handwriting
// label font), to match the sketch-note aesthetic. The wobble is SEEDED off each shape's geometry so
// the same diagram always draws identically (no Math.random — deterministic + test-stable).

export type DiagramStyle = 'clean' | 'sketch';

/** A tiny deterministic PRNG (mulberry32) seeded per-shape so a diagram redraws identically. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(...nums: number[]): number {
  let s = 2166136261;
  for (const n of nums) { s = Math.imul(s ^ Math.round(n * 7.3), 16777619); }
  return s >>> 0;
}

/** One hand-drawn line as an SVG path `d` — a quadratic with an offset mid-point (the Rough.js trick). */
function roughLine(x1: number, y1: number, x2: number, y2: number, r: () => number, amp = 2.2): string {
  const mx = (x1 + x2) / 2 + (r() - 0.5) * amp * 2;
  const my = (y1 + y2) / 2 + (r() - 0.5) * amp * 2;
  const j = () => (r() - 0.5) * amp;
  return `M ${(x1 + j()).toFixed(1)} ${(y1 + j()).toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${(x2 + j()).toFixed(1)} ${(y2 + j()).toFixed(1)}`;
}

/** A hand-drawn rounded rectangle border — four wobbly sides, drawn as one path (double-pass feel). */
function roughRectPath(x: number, y: number, w: number, h: number, r: () => number): string {
  const sides = [
    roughLine(x, y, x + w, y, r),
    roughLine(x + w, y, x + w, y + h, r),
    roughLine(x + w, y + h, x, y + h, r),
    roughLine(x, y + h, x, y, r),
  ];
  return sides.join(' ');
}

/**
 * Render a diagram scene to a self-contained `<svg>`.
 * - `style: 'clean'` (default) — crisp rounded coloured nodes + smooth arrows.
 * - `style: 'sketch'` — HAND-DRAWN: wobbly Rough.js-style strokes + a handwriting label font, to
 *   match the sketch-note aesthetic. Deterministic (seeded), so a diagram always redraws identically.
 */
export function diagramToSvg(scene: DiagramScene, opts: { style?: DiagramStyle } = {}): string {
  const sketch = opts.style === 'sketch';
  const labelFont = sketch ? "'Caveat','Patrick Hand',cursive" : 'system-ui,sans-serif';
  const sw = sketch ? 2 : 1.5;
  const layout = layoutDiagram(scene);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  parts.push(`<defs><marker id="gw-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${READING_INK}"/></marker></defs>`);
  if (scene.title) parts.push(`<text x="${layout.width / 2}" y="18" text-anchor="middle" font-family="${labelFont}" font-size="${sketch ? 17 : 13}" font-weight="700" fill="${READING_INK}">${esc(scene.title)}</text>`);

  // Edges first (under the nodes).
  for (const e of scene.edges) {
    const a = byId.get(e.from); const b = byId.get(e.to); if (!a || !b) continue;
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    const stroke = e.color && sanitizeColor(e.color) ? sanitizeColor(e.color)! : READING_INK;
    if (sketch) {
      const r = rng(seedOf(x1, y1, x2, y2));
      parts.push(`<path d="${roughLine(x1, y1, x2, y2, r, 3)}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round" marker-end="url(#gw-arrow)" opacity="0.85"/>`);
    } else {
      parts.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}" marker-end="url(#gw-arrow)" opacity="0.8"/>`);
    }
    if (e.label) parts.push(`<text x="${mx}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" font-family="${labelFont}" font-size="${sketch ? 13 : 10}" fill="#5E6E67">${esc(e.label)}</text>`);
  }
  // Nodes. Each node is wrapped in a `<g data-node-id>` group so an editor can map a click to a
  // node (rename / recolour / delete). The group is inert for share/export rendering.
  for (const n of layout.nodes) {
    const fill = n.color ?? HIGHLIGHT_PALETTE[0]!.color;
    const stroke = darken(fill);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const x = n.x, y = n.y, w = n.w, hh = n.h;
    const shapeParts: string[] = [];
    if (sketch && (n.shape === undefined || n.shape === 'box' || n.shape === 'pill')) {
      // Hand-drawn rounded box: a soft solid fill underneath + a wobbly hand-drawn border on top.
      const r = rng(seedOf(x, y, w, hh));
      const rx = n.shape === 'pill' ? hh / 2 : 12;
      shapeParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${rx}" fill="${fill}" opacity="0.92"/>`);
      shapeParts.push(`<path d="${roughRectPath(x, y, w, hh, r)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (n.shape === 'diamond') {
      shapeParts.push(`<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + hh} ${x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    } else if (n.shape === 'ellipse') {
      shapeParts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${hh / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    } else if (n.shape === 'cylinder') {
      const ry = Math.min(8, hh / 4);
      shapeParts.push(`<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + hh - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + hh - ry} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/><path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
    } else if (n.shape === 'parallelogram') {
      const sk = Math.min(16, w / 4);
      shapeParts.push(`<polygon points="${x + sk},${y} ${x + w},${y} ${x + w - sk},${y + hh} ${x},${y + hh}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    } else if (n.shape === 'hexagon') {
      const sk = Math.min(16, w / 4);
      shapeParts.push(`<polygon points="${x + sk},${y} ${x + w - sk},${y} ${x + w},${cy} ${x + w - sk},${y + hh} ${x + sk},${y + hh} ${x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    } else {
      const rx = n.shape === 'pill' ? hh / 2 : 10;
      shapeParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    }
    shapeParts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${labelFont}" font-size="${sketch ? 15 : 12}" font-weight="600" fill="${READING_INK}">${esc(n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label)}</text>`);
    parts.push(`<g class="gw-dnode" data-node-id="${esc(n.id)}">${shapeParts.join('')}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="gw-diagram${sketch ? ' sketch' : ''}">${parts.join('')}</svg>`;
}
