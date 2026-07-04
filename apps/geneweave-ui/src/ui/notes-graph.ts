// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 5 — the "Connections" panel for a note.
 *
 * --- For someone new to this ---
 * This shows how a note connects to the rest of your notes — like the side panel in
 * Obsidian. Four things:
 *   • Backlinks — other notes that point AT this one (via a [[wiki-link]]).
 *   • Unlinked mentions — notes whose title you typed here in plain text but didn't
 *     turn into a link yet (one-click candidates to connect).
 *   • Related notes — notes that are about similar things, found by meaning (an AI
 *     "embedding"), even if you never linked them.
 *   • A tiny knowledge GRAPH — a picture of this note, the notes it links to, and the
 *     people/concepts (entities) the AI found in it.
 *
 * "Index" asks the server to (re)compute all of this for the note: resolve its
 * [[links]], extract entities/relations with the AI, and embed it for the related-
 * notes search.
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface NoteConnectionsPanel {
  /** Re-fetch + re-render all four sections. */
  refresh(): Promise<void>;
  /** Ask the server to (re)index the note (links + entities + embedding), then refresh. */
  index(): Promise<void>;
  close(): void;
}

interface Backlink { noteId: string; title: string }
interface Unlinked { noteId: string; title: string; count: number }
interface Related { noteId: string; title: string; score: number }
interface GraphNode { id: string; label: string; kind: 'note' | 'entity'; type?: string }
interface GraphEdge { source: string; target: string; label: string }
// weaveNotes Phase 3 (GraphRAG) — a note connected to this one through a shared canonical entity.
interface EntityRelated { noteId: string; title: string; shared: number; via: string[] }
// weaveNotes Phase 3 — proactive linking.
interface LinkSuggestion { targetId: string; targetTitle: string; kind: 'mention' | 'related'; reason: string; weight: number }

export function wireNoteConnections(opts: { noteId: string; panelEl: HTMLElement; onOpenNote: (id: string) => void; onApplied?: () => void }): NoteConnectionsPanel {
  const { noteId, panelEl, onOpenNote, onApplied } = opts;

  function section(title: string, body: HTMLElement): HTMLElement {
    return h('div', { className: 'notes-conn-section' }, h('div', { className: 'notes-conn-title' }, title), body);
  }
  function noteChip(id: string, label: string, extra?: string): HTMLElement {
    return h('button', { className: 'notes-conn-chip', onClick: () => onOpenNote(id) }, label + (extra ? ` ${extra}` : ''));
  }

  // weaveNotes Phase 3 — turn a suggestion into a real [[wiki-link]] in the note (server-side,
  // lossless), then reload the editor so the link + its new backlink appear.
  async function applyLink(title: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true; btn.textContent = 'Linking…';
    try {
      const res = await api.post(`/api/me/notes/${noteId}/link-suggestions/apply`, { targetTitle: title });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; linked?: boolean; error?: string };
      if (res.ok && data.ok && data.linked) { onApplied?.(); await refresh(); return; }
      btn.textContent = data.linked === false ? 'No plain mention' : 'Couldn’t link';
    } catch { btn.textContent = 'Error'; }
  }
  // A proactive suggestion row: the target title + a short reason, an "open" affordance, and (for a
  // verbatim mention) a one-click "🔗 Link" button.
  function suggestionRow(s: LinkSuggestion): HTMLElement {
    const open = h('button', { className: 'notes-conn-chip', title: 'Open this note', onClick: () => onOpenNote(s.targetId) }, s.targetTitle) as HTMLElement;
    const reason = h('span', { className: 'notes-conn-reason' }, s.reason);
    const row = h('div', { className: 'notes-suggest-row' }, open, reason) as HTMLElement;
    if (s.kind === 'mention') {
      const link = h('button', { className: 'notes-suggest-link-btn', title: `Link the first mention of “${s.targetTitle}”` }, '🔗 Link') as HTMLButtonElement;
      link.addEventListener('click', () => void applyLink(s.targetTitle, link));
      row.appendChild(link);
    }
    return row;
  }

  async function get<T>(path: string, fallback: T): Promise<T> {
    try { const res = await api.get(`/api/me/notes/${noteId}/${path}`); return res.ok ? (await res.json() as T) : fallback; } catch { return fallback; }
  }

  /** Tiny SVG knowledge graph: the note in the centre, neighbours around a circle. */
  function renderGraph(g: { nodes: GraphNode[]; edges: GraphEdge[] }): HTMLElement {
    const W = 320, H = 240, cx = W / 2, cy = H / 2, R = 92;
    if (g.nodes.length <= 1) return h('div', { className: 'notes-conn-empty' }, 'Index the note to build its graph.');
    const center = g.nodes[0]!; // the note itself is first
    const others = g.nodes.slice(1);
    const pos = new Map<string, { x: number; y: number }>();
    pos.set(center.id, { x: cx, y: cy });
    others.forEach((n, i) => {
      const a = (i / Math.max(1, others.length)) * Math.PI * 2;
      pos.set(n.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
    });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'notes-conn-graph');
    for (const e of g.edges) {
      const a = pos.get(e.source), b = pos.get(e.target); if (!a || !b) continue;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
      line.setAttribute('stroke', '#9aa4b2'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
    }
    for (const n of g.nodes) {
      const p = pos.get(n.id); if (!p) continue;
      const circ = document.createElementNS(ns, 'circle');
      circ.setAttribute('cx', String(p.x)); circ.setAttribute('cy', String(p.y));
      circ.setAttribute('r', n.kind === 'note' ? '8' : '5');
      circ.setAttribute('fill', n.kind === 'note' ? '#4f8cff' : '#b07cff');
      svg.appendChild(circ);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(p.x + 10)); label.setAttribute('y', String(p.y + 4));
      label.setAttribute('font-size', '10'); label.setAttribute('fill', '#444');
      label.textContent = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
      svg.appendChild(label);
    }
    const wrap = h('div', {});
    wrap.appendChild(svg);
    return wrap;
  }

  async function refresh(): Promise<void> {
    panelEl.innerHTML = '';
    panelEl.appendChild(h('div', { className: 'notes-conn-loading' }, 'Loading connections…'));
    const [backlinks, unlinkedRes, relatedRes, suggestRes, entityRes, graph] = await Promise.all([
      get<{ backlinks: Backlink[] }>('backlinks', { backlinks: [] }),
      get<{ unlinked: Unlinked[] }>('unlinked', { unlinked: [] }),
      get<{ related: Related[] }>('related', { related: [] }),
      get<{ suggestions: LinkSuggestion[]; disabled?: boolean }>('link-suggestions', { suggestions: [] }),
      get<{ related: EntityRelated[] }>('entity-related', { related: [] }),
      get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('graph', { nodes: [], edges: [] }),
    ]);
    panelEl.innerHTML = '';

    panelEl.appendChild(h('div', { className: 'notes-conn-header' },
      h('span', { className: 'notes-conn-heading' }, '🔗 Connections'),
      h('button', { className: 'notes-conn-index-btn', title: 'Re-index this note (links + entities + related)', onClick: () => void index() }, '↻ Index'),
      h('button', { className: 'notes-conn-index-btn', title: 'Rebuild the whole knowledge graph (batched embeddings + entity resolution across all your notes)', onClick: () => void rebuild() }, '🕸 Rebuild'),
    ));

    // weaveNotes Phase 3 — proactive link suggestions, first (what to do next), with one-click apply.
    if (!suggestRes.disabled) {
      panelEl.appendChild(section(`💡 Suggested links (${suggestRes.suggestions.length})`,
        suggestRes.suggestions.length
          ? h('div', { className: 'notes-suggest-list' }, ...suggestRes.suggestions.map((s) => suggestionRow(s)))
          : h('div', { className: 'notes-conn-empty' }, 'Nothing to link right now.')));
    }

    panelEl.appendChild(section(`Backlinks (${backlinks.backlinks.length})`,
      backlinks.backlinks.length
        ? h('div', { className: 'notes-conn-list' }, ...backlinks.backlinks.map((b) => noteChip(b.noteId, b.title)))
        : h('div', { className: 'notes-conn-empty' }, 'No notes link here yet.')));

    panelEl.appendChild(section(`Unlinked mentions (${unlinkedRes.unlinked.length})`,
      unlinkedRes.unlinked.length
        ? h('div', { className: 'notes-conn-list' }, ...unlinkedRes.unlinked.map((u) => noteChip(u.noteId, u.title, `(${u.count})`)))
        : h('div', { className: 'notes-conn-empty' }, 'No unlinked mentions.')));

    panelEl.appendChild(section(`Related notes (${relatedRes.related.length})`,
      relatedRes.related.length
        ? h('div', { className: 'notes-conn-list' }, ...relatedRes.related.map((r) => noteChip(r.noteId, r.title, `· ${(r.score * 100).toFixed(0)}%`)))
        : h('div', { className: 'notes-conn-empty' }, 'No related notes yet — try Index.')));

    // Phase 3 (GraphRAG) — notes connected THROUGH a shared entity (same person/org/concept).
    panelEl.appendChild(section(`Connected through (${entityRes.related.length})`,
      entityRes.related.length
        ? h('div', { className: 'notes-conn-list' }, ...entityRes.related.map((r) => noteChip(r.noteId, r.title, `· via ${r.via.slice(0, 2).join(', ')}${r.shared > 2 ? ' …' : ''}`)))
        : h('div', { className: 'notes-conn-empty' }, 'No shared entities yet — try Rebuild.')));

    panelEl.appendChild(section('Knowledge graph', renderGraph(graph)));
  }

  async function index(): Promise<void> {
    panelEl.innerHTML = '';
    panelEl.appendChild(h('div', { className: 'notes-conn-loading' }, 'Indexing — resolving links, extracting entities, embedding…'));
    try { await api.post(`/api/me/notes/${noteId}/index`, {}); } catch { /* show whatever we can */ }
    await refresh();
  }

  // Phase 3 (GraphRAG) — rebuild the WHOLE knowledge graph: batched embeddings + entity resolution
  // across every note, so notes connect through the same people/orgs/concepts even when worded apart.
  async function rebuild(): Promise<void> {
    panelEl.innerHTML = '';
    panelEl.appendChild(h('div', { className: 'notes-conn-loading' }, 'Rebuilding the knowledge graph — batched embeddings + entity resolution across your notes…'));
    try { await api.post('/api/me/notes/reindex', { extractGraph: true }); } catch { /* show whatever we can */ }
    await refresh();
  }

  void refresh();
  return { refresh, index, close() { /* nothing live to release */ } };
}
