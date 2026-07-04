// notes-creative-extensions.ts — weaveNotes Phase 1 custom Tiptap marks + nodes.
//
// Hand-rolled (no extra @tiptap/* installs) so the editor gains text colour, a
// multi-colour highlighter, callouts, toggles, image embeds, stickers and washi
// dividers. The node/mark NAMES here MATCH the @weaveintel/collab round-trip
// (pmToBlocks / blocksToProseMirror) exactly, so creative content survives the CRDT
// co-edit relay — and the colour the AI/user picks is preserved through a merge.
//
// `author` attributes carry the agency-colour contract (Phase 0): a callout/sticker the
// AI created renders mint; a human's stays neutral. The CSS lives in the canvas styles.
import { Mark, Node, mergeAttributes } from '@tiptap/core';
// The notes editor BUNDLE is esbuild-compiled, so it can import the weaveIntel renderers
// (unlike the main tsc-built UI client) — Phase 4 ink + diagrams render via the shared,
// tested @weaveintel/notes SVG renderers, so the picture is identical server-, share-, and
// editor-side.
import { strokesToSvg, validateStrokes, type InkStroke } from '@weaveintel/notes';
import { diagramToSvg, validateDiagramScene, HIGHLIGHT_PALETTE } from './notes/index.js';

// The recolour swatches in the diagram editor — a subset of the shared WCAG-AA highlight palette
// (its labels resolve back to the same pastels in the renderer, so a recolour survives validation).
const DIAGRAM_SWATCHES = HIGHLIGHT_PALETTE.filter((p) => ['amber', 'pink', 'teal', 'blue', 'lavender', 'sage'].includes(p.label));

// Tiptap's RawCommands is augmented per-extension; we add commands without global
// module augmentation, so cast the returned command bag. Localized + intentional.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only allow an inert CSS colour (hex / rgb[a] / hsl[a] / short named). Mirrors @weaveintel/notes sanitizeColor. */
function safeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 32) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^hsla?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase();
  return null;
}

/** Only allow a safe image src: http(s), an inert data:image URI, or a same-origin artifact path. */
function safeSrc(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  // Same-origin generated-image / artifact path (Phase 4): /api/artifacts/<id>/data
  if (/^\/api\/artifacts\/[\w-]+\/data$/.test(s)) return s;
  return null;
}

// ─── Highlight mark (multi-colour highlighter) ──────────────────────────────────────
export const Highlight = Mark.create({
  name: 'highlight',
  addOptions() { return { HTMLAttributes: {} }; },
  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color') || el.style.backgroundColor || null,
        renderHTML: (attrs: { color?: string | null }) => {
          const c = safeColor(attrs.color);
          return c ? { 'data-color': c, style: `background-color:${c};border-radius:.2em;padding:0 .08em` } : {};
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'mark' }]; },
  renderHTML({ HTMLAttributes }) { return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]; },
  addCommands() {
    return {
      setHighlight: (attrs: { color?: string }) => ({ commands }: any) => commands.setMark('highlight', attrs),
      toggleHighlight: (attrs: { color?: string }) => ({ commands }: any) => commands.toggleMark('highlight', attrs),
      unsetHighlight: () => ({ commands }: any) => commands.unsetMark('highlight'),
    } as any;
  },
});

// ─── Text colour mark ───────────────────────────────────────────────────────────────
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.style.color || null,
        renderHTML: (attrs: { color?: string | null }) => {
          const c = safeColor(attrs.color);
          return c ? { style: `color:${c}` } : {};
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'span[style*="color"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
  addCommands() {
    return {
      setTextColor: (color: string) => ({ commands }: any) => commands.setMark('textColor', { color }),
      unsetTextColor: () => ({ commands }: any) => commands.unsetMark('textColor'),
    } as any;
  },
});

// ─── Callout node ─────────────────────────────────────────────────────────────────
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      tone: { default: 'note', parseHTML: (el: HTMLElement) => el.getAttribute('data-tone') || 'note', renderHTML: (a: { tone?: string }) => ({ 'data-tone': a.tone || 'note' }) },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'gw-callout' }), 0]; },
  addCommands() {
    return {
      setCallout: (attrs: { tone?: string; author?: string }) => ({ commands }: any) => commands.wrapIn('callout', attrs),
      toggleCallout: (attrs: { tone?: string; author?: string }) => ({ commands }: any) => commands.toggleWrap('callout', attrs),
    } as any;
  },
});

// ─── Toggle node (collapsible) ──────────────────────────────────────────────────────
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      summary: { default: 'Details', parseHTML: (el: HTMLElement) => el.getAttribute('data-summary') || 'Details', renderHTML: (a: { summary?: string }) => ({ 'data-summary': a.summary || 'Details' }) },
      open: { default: true, parseHTML: (el: HTMLElement) => el.getAttribute('data-open') !== 'false', renderHTML: (a: { open?: boolean }) => ({ 'data-open': a.open === false ? 'false' : 'true' }) },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-toggle]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const summary = String((node.attrs as { summary?: string }).summary ?? 'Details');
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'gw-toggle' }),
      ['div', { class: 'gw-toggle-summary', contenteditable: 'false' }, `▸ ${summary}`],
      ['div', { class: 'gw-toggle-body' }, 0]];
  },
  addCommands() {
    return {
      setToggle: (attrs: { summary?: string; author?: string }) => ({ commands }: any) => commands.wrapIn('toggle', attrs),
    } as any;
  },
});

// ─── Image node (atom) ──────────────────────────────────────────────────────────────
export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null as string | null },
      alt: { default: null as string | null },
      // Attribution caption + source/licence link, for images SOURCED from the web (find_image).
      caption: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-caption'), renderHTML: (a: { caption?: string | null }) => (a.caption ? { 'data-caption': a.caption } : {}) },
      href: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-href'), renderHTML: (a: { href?: string | null }) => (a.href ? { 'data-href': a.href } : {}) },
      license: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-license'), renderHTML: (a: { license?: string | null }) => (a.license ? { 'data-license': a.license } : {}) },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'figure[data-image]' }, { tag: 'figure[data-image] img' }, { tag: 'img[src]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as { src?: string; alt?: string; caption?: string; href?: string };
    const src = safeSrc(attrs.src);
    const children: unknown[] = [src
      ? ['img', mergeAttributes(HTMLAttributes, { src, alt: attrs.alt ?? '' })]
      : ['figcaption', {}, attrs.alt ?? 'image']];
    // A visible attribution caption (with a source link when present) — required for CC-BY/BY-SA.
    if (attrs.caption && attrs.caption.trim()) {
      const safeHref = attrs.href && /^https?:\/\//i.test(attrs.href) ? attrs.href : null;
      children.push(['figcaption', { class: 'gw-image-credit' },
        safeHref ? ['a', { href: safeHref, target: '_blank', rel: 'noopener nofollow' }, attrs.caption] : attrs.caption]);
    }
    return ['figure', { 'data-image': '', class: 'gw-image' }, ...children];
  },
  addCommands() {
    return {
      setImage: (attrs: { src?: string; alt?: string; author?: string; caption?: string; href?: string; license?: string }) => ({ commands }: any) => {
        const src = safeSrc(attrs.src);
        if (!src) return false;
        return commands.insertContent({ type: 'image', attrs: { ...attrs, src } });
      },
    } as any;
  },
});

// ─── Sticker node (block-level atom) ────────────────────────────────────────────────
export const Sticker = Node.create({
  name: 'sticker',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      emoji: { default: '✨' },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'span[data-sticker]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const emoji = String((node.attrs as { emoji?: string }).emoji ?? '✨');
    return ['span', mergeAttributes(HTMLAttributes, { 'data-sticker': '', class: 'gw-sticker' }), emoji];
  },
  addCommands() {
    return {
      setSticker: (attrs: { emoji?: string; author?: string }) => ({ commands }: any) => commands.insertContent({ type: 'sticker', attrs: attrs ?? {} }),
    } as any;
  },
});

// ─── Washi divider node (block-level atom) ──────────────────────────────────────────
export const WashiDivider = Node.create({
  name: 'washiDivider',
  group: 'block',
  atom: true,
  addAttributes() {
    return { pattern: { default: 'tape', parseHTML: (el: HTMLElement) => el.getAttribute('data-pattern') || 'tape', renderHTML: (a: { pattern?: string }) => ({ 'data-pattern': a.pattern || 'tape' }) } };
  },
  parseHTML() { return [{ tag: 'div[data-washi]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-washi': '', class: 'gw-washi' })]; },
  addCommands() {
    return {
      setWashiDivider: (attrs: { pattern?: string }) => ({ commands }: any) => commands.insertContent({ type: 'washiDivider', attrs: attrs ?? {} }),
    } as any;
  },
});

// ─── Diagram node (Phase 4) — native, editable, colour-coded diagram (renders to SVG) ──────────
export const DiagramNode = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      // The scene is structured JSON (nodes/edges). It round-trips as an object in doc_json; the
      // data-scene HTML attr is only used for copy/paste fidelity.
      scene: {
        default: null,
        parseHTML: (el: HTMLElement) => { try { return JSON.parse(el.getAttribute('data-scene') || 'null'); } catch { return null; } },
        renderHTML: (a: { scene?: unknown }) => (a.scene ? { 'data-scene': JSON.stringify(a.scene) } : {}),
      },
      title: { default: '' },
      kind: { default: 'flow' },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'figure[data-diagram]' }]; },
  renderHTML({ HTMLAttributes }) { return ['figure', mergeAttributes(HTMLAttributes, { 'data-diagram': '', class: 'gw-diagram-block' })]; },
  addNodeView() {
    // An EDITABLE diagram: click a node to rename / recolour / delete it, or add a new node
    // (connected to the selected one). The AI authors the same scene data, so "the AI drew it"
    // and "I edited it" are the same object — every change persists back into the note's doc_json
    // through the CRDT relay (same setNodeMarkup path the ink canvas uses).
    return ({ node, editor, getPos }: any) => {
      const dom = document.createElement('figure');
      dom.className = 'gw-diagram-block';
      if (node.attrs.author) dom.setAttribute('data-author', node.attrs.author);
      let scene: any = validateDiagramScene(node.attrs.scene);
      let selectedId: string | null = null;

      const canvas = document.createElement('div');
      canvas.className = 'gw-diagram-canvas';
      const panel = document.createElement('div');
      panel.className = 'gw-diagram-editor';
      panel.setAttribute('contenteditable', 'false');

      const persist = (): void => {
        try {
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos !== 'number') return; // detached node-view
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, scene }));
        } catch { /* read-only / detached */ }
      };
      // Re-render ONLY the SVG (keeps the editor panel — and its focused inputs — intact).
      const drawCanvas = (): void => {
        try { canvas.innerHTML = diagramToSvg(scene, { style: 'sketch' }); }
        catch { canvas.textContent = '[diagram]'; return; }
        if (!editor.isEditable) return;
        canvas.querySelector('svg')?.querySelectorAll('[data-node-id]').forEach((g: Element) => {
          const id = g.getAttribute('data-node-id');
          (g as SVGElement).style.cursor = 'pointer';
          if (id === selectedId) g.classList.add('gw-dnode-sel');
          g.addEventListener('mousedown', (e) => { e.preventDefault(); selectedId = selectedId === id ? null : id; drawCanvas(); renderPanel(); });
        });
      };
      const mutate = (fn: () => void): void => { fn(); scene = validateDiagramScene(scene); persist(); drawCanvas(); renderPanel(); };

      function renderPanel(): void {
        panel.innerHTML = '';
        if (!editor.isEditable) return;
        const btn = (label: string, title: string, on: () => void): HTMLButtonElement => {
          const b = document.createElement('button'); b.className = 'gw-diagram-btn'; b.textContent = label; b.title = title;
          b.onmousedown = (e) => { e.preventDefault(); on(); };
          return b;
        };
        // Always-available: add a node (connected to the selection if one is picked).
        panel.appendChild(btn('＋ Node', 'Add a node', () => {
          const id = 'n' + Math.random().toString(36).slice(2, 8);
          const from = selectedId;
          mutate(() => { scene.nodes.push({ id, label: 'New node' }); if (from) scene.edges.push({ from, to: id }); });
          selectedId = id; drawCanvas(); renderPanel();
        }));

        const sel = selectedId ? scene.nodes.find((n: any) => n.id === selectedId) : null;
        if (!sel) { panel.appendChild(hint('Click a node to rename, recolour or delete it.')); return; }
        // Rename (live) — only the canvas redraws on each keystroke, so the input keeps focus.
        const input = document.createElement('input');
        input.className = 'gw-diagram-label'; input.value = String(sel.label ?? ''); input.placeholder = 'Label';
        input.oninput = () => { sel.label = input.value; persist(); drawCanvas(); };
        panel.appendChild(input);
        // Recolour swatches (palette labels resolve to WCAG-AA pastels in the renderer).
        for (const p of DIAGRAM_SWATCHES) {
          const sw = document.createElement('button');
          sw.className = 'gw-diagram-swatch'; sw.title = p.label; sw.style.background = p.color;
          sw.onmousedown = (e) => { e.preventDefault(); sel.color = p.label; mutate(() => {}); };
          panel.appendChild(sw);
        }
        // Delete the selected node (its incident edges go too, via re-validation).
        panel.appendChild(btn('🗑 Delete', 'Delete this node', () => {
          const gone = selectedId; selectedId = null;
          mutate(() => { scene.nodes = scene.nodes.filter((n: any) => n.id !== gone); scene.edges = scene.edges.filter((e: any) => e.from !== gone && e.to !== gone); });
        }));
      }
      function hint(text: string): HTMLElement { const s = document.createElement('span'); s.className = 'gw-diagram-hint'; s.textContent = text; return s; }

      drawCanvas();
      renderPanel();
      dom.appendChild(canvas);
      dom.appendChild(panel);
      return {
        dom,
        // Re-render when the scene changes underneath us (e.g. an accepted AI suggestion).
        update: (updated: any) => { if (updated.type.name !== 'diagram') return false; scene = validateDiagramScene(updated.attrs.scene); drawCanvas(); renderPanel(); return true; },
        ignoreMutation: () => true,
      };
    };
  },
  addCommands() {
    return {
      setDiagram: (attrs: { scene?: unknown; title?: string; kind?: string; author?: string }) => ({ commands }: any) => commands.insertContent({ type: 'diagram', attrs: attrs ?? {} }),
    } as any;
  },
});

// ─── Ink canvas node (Phase 4) — real freehand strokes; AI- + human-drawable ───────────────────
export const InkCanvasNode = Node.create({
  name: 'inkCanvas',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      strokes: {
        default: [],
        parseHTML: (el: HTMLElement) => { try { return JSON.parse(el.getAttribute('data-strokes') || '[]'); } catch { return []; } },
        renderHTML: (a: { strokes?: unknown }) => ({ 'data-strokes': JSON.stringify(a.strokes ?? []) }),
      },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'figure[data-ink]' }]; },
  renderHTML({ HTMLAttributes }) { return ['figure', mergeAttributes(HTMLAttributes, { 'data-ink': '', class: 'gw-ink-block' })]; },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      const dom = document.createElement('figure');
      dom.className = 'gw-ink-block';
      if (node.attrs.author) dom.setAttribute('data-author', node.attrs.author);
      let strokes: InkStroke[] = validateStrokes(node.attrs.strokes);
      let penColor = '#14201B';
      let eraser = false;

      const surface = document.createElement('div');
      surface.className = 'gw-ink-surface';
      const render = (): void => { surface.innerHTML = strokes.length ? strokesToSvg(strokes, { width: 480, height: 200 }) : '<div class="gw-ink-empty">Draw here ✎</div>'; };
      render();

      // A tiny pen toolbar (colour swatches + eraser + clear).
      const bar = document.createElement('div');
      bar.className = 'gw-ink-toolbar';
      bar.setAttribute('contenteditable', 'false');
      const persist = (): void => {
        try { const pos = getPos(); editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, strokes })); } catch { /* read-only / detached */ }
      };
      for (const c of ['#14201B', '#D85A30', '#3B6FB0', '#0B6B4F']) {
        const sw = document.createElement('button');
        sw.className = 'gw-ink-swatch'; sw.style.background = c; sw.title = 'Pen';
        sw.onmousedown = (e) => { e.preventDefault(); penColor = c; eraser = false; };
        bar.appendChild(sw);
      }
      const erBtn = document.createElement('button'); erBtn.className = 'gw-ink-erase'; erBtn.textContent = '⌫'; erBtn.title = 'Eraser';
      erBtn.onmousedown = (e) => { e.preventDefault(); eraser = true; };
      bar.appendChild(erBtn);
      const clr = document.createElement('button'); clr.className = 'gw-ink-clear'; clr.textContent = 'Clear';
      clr.onmousedown = (e) => { e.preventDefault(); strokes = []; render(); persist(); };
      bar.appendChild(clr);

      // Pointer drawing: collect points → one stroke per drag.
      let drawing: InkStroke | null = null;
      const ptr = (e: PointerEvent): { x: number; y: number; p: number } => {
        const r = surface.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
      };
      surface.addEventListener('pointerdown', (e) => {
        if (!editor.isEditable) return;
        e.preventDefault();
        const pt = ptr(e);
        drawing = { points: [pt], color: penColor, width: eraser ? 16 : 3, tool: eraser ? 'eraser' : 'pen', author: 'user' };
        try { surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      surface.addEventListener('pointermove', (e) => { if (drawing) { drawing.points.push(ptr(e)); strokes = [...strokes.filter((s) => s !== drawing), drawing]; render(); } });
      const end = (): void => { if (drawing) { drawing = null; persist(); } };
      surface.addEventListener('pointerup', end);
      surface.addEventListener('pointerleave', end);

      dom.appendChild(bar);
      dom.appendChild(surface);
      return {
        dom,
        update: (updated: any) => { if (updated.type.name !== 'inkCanvas') return false; strokes = validateStrokes(updated.attrs.strokes); render(); return true; },
        ignoreMutation: () => true,
      };
    };
  },
  addCommands() {
    return {
      setInkCanvas: (attrs: { strokes?: unknown; author?: string }) => ({ commands }: any) => commands.insertContent({ type: 'inkCanvas', attrs: attrs ?? { strokes: [] } }),
    } as any;
  },
});
