// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 5 — background memory ("second brain") UI.
 *
 * --- For someone new to this ---
 * As you write notes over time, the app quietly remembers the DURABLE things about you — facts,
 * preferences, decisions, people, commitments. Two things live here:
 *   1. A proactive STRIP above the note: when what you're writing relates to something you told the
 *      app before, it gently surfaces it ("🧠 You mentioned: prefers async standups — 3 weeks ago").
 *   2. A "Your memory" PANEL (Insert → 🧠 Your memory): search everything the app remembers about you,
 *      and forget anything you don't want kept. Nothing here is a chore — the remembering happens in
 *      the background; this is just how you see and steer it.
 */
import { h } from './dom.js';
import { api } from './api.js';

interface Memory { id: string; content: string; kind?: string; subject?: string; whenLabel?: string; importance?: number; noteId?: string; score?: number }

const KIND_ICON: Record<string, string> = { fact: '•', preference: '★', decision: '✓', relationship: '👤', task: '☑', event: '📅' };

/** The proactive strip: recalls memories relevant to the OPEN note (excludes this note's own memories). */
export interface MemoryStrip { refresh(): Promise<void>; destroy(): void }

export function wireMemoryStrip(opts: { noteId: string; barEl: HTMLElement }): MemoryStrip {
  const { noteId, barEl } = opts;
  let destroyed = false;
  barEl.style.display = 'none';
  barEl.className = 'notes-memory-strip';

  async function refresh(): Promise<void> {
    if (destroyed) return;
    let memories: Memory[] = []; let disabled = false;
    try {
      const res = await api.get(`/api/me/notes/${noteId}/recall?limit=3`);
      if (res.ok) { const d = await res.json() as { memories?: Memory[]; disabled?: boolean }; memories = d.memories ?? []; disabled = !!d.disabled; }
    } catch { /* keep hidden */ }
    if (destroyed || disabled || memories.length === 0) { barEl.style.display = 'none'; barEl.innerHTML = ''; return; }
    barEl.innerHTML = '';
    barEl.appendChild(h('span', { className: 'notes-memory-strip-label' }, '🧠 From your memory:'));
    const list = h('span', { className: 'notes-memory-strip-items' },
      ...memories.map((m) => h('span', { className: 'notes-memory-chip', title: `${m.kind ?? 'memory'}${m.subject ? ` · ${m.subject}` : ''}${m.whenLabel ? ` · ${m.whenLabel}` : ''}` },
        `${KIND_ICON[m.kind ?? 'fact'] ?? '•'} ${m.content}${m.whenLabel ? ` — ${m.whenLabel}` : ''}`)),
    );
    barEl.appendChild(list);
    const close = h('button', { className: 'notes-memory-strip-dismiss', title: 'Dismiss', onClick: () => { barEl.style.display = 'none'; } }, '✕') as HTMLButtonElement;
    barEl.appendChild(close);
    barEl.style.display = '';
  }

  void refresh();
  return { refresh, destroy() { destroyed = true; barEl.style.display = 'none'; barEl.innerHTML = ''; } };
}

/** The "Your memory" panel: search + browse + forget everything the app remembers about you. */
export function renderMemoryPanel(onOpenNote: (id: string) => void): HTMLElement {
  const status = h('div', { className: 'notes-memory-status' }) as HTMLElement;
  const listEl = h('div', { className: 'notes-memory-list' }) as HTMLElement;
  const searchInput = h('input', { className: 'notes-memory-search', placeholder: 'Ask what you know… e.g. "Polaris project" or "preferences"' }) as HTMLInputElement;

  const memoryRow = (m: Memory): HTMLElement => {
    const meta = h('span', { className: 'notes-memory-row-meta' }, `${KIND_ICON[m.kind ?? 'fact'] ?? '•'} ${m.kind ?? 'fact'}${m.subject ? ` · ${m.subject}` : ''}${m.whenLabel ? ` · ${m.whenLabel}` : ''}`);
    const forget = h('button', { className: 'notes-memory-forget', title: 'Forget this' }, '✕') as HTMLButtonElement;
    const row = h('div', { className: 'notes-memory-row' },
      h('div', { className: 'notes-memory-row-main' }, h('div', { className: 'notes-memory-row-text' }, m.content), meta),
      forget,
    ) as HTMLElement;
    if (m.noteId) { const open = h('button', { className: 'notes-memory-open', title: 'Open the source note', onClick: () => { document.querySelector('.gw-modal-overlay')?.remove(); onOpenNote(m.noteId!); } }, '↗') as HTMLElement; (row.querySelector('.notes-memory-row-main') as HTMLElement).appendChild(open); }
    forget.addEventListener('click', async () => {
      forget.disabled = true;
      try { const res = await api.del(`/api/me/memory/${m.id}`); if (res.ok) row.remove(); else forget.disabled = false; } catch { forget.disabled = false; }
    });
    return row;
  };

  async function loadAll(): Promise<void> {
    status.textContent = 'Loading what I remember about you…';
    try {
      const res = await api.get('/api/me/memory?limit=200');
      const d = await res.json().catch(() => ({ memories: [] })) as { memories?: Memory[] };
      renderList(d.memories ?? [], `${(d.memories ?? []).length} memories (newest first)`);
    } catch { status.textContent = 'Could not load your memory.'; }
  }
  async function search(q: string): Promise<void> {
    if (!q.trim()) { void loadAll(); return; }
    status.textContent = 'Recalling…';
    try {
      const res = await api.post('/api/me/memory/recall', { query: q, limit: 10 });
      const d = await res.json().catch(() => ({ memories: [] })) as { memories?: Memory[]; disabled?: boolean };
      if (d.disabled) { status.textContent = 'Background memory is turned off for this workspace.'; listEl.innerHTML = ''; return; }
      renderList(d.memories ?? [], `${(d.memories ?? []).length} recalled — most relevant, recent and important first`);
    } catch { status.textContent = 'Recall failed.'; }
  }
  function renderList(memories: Memory[], caption: string): void {
    status.textContent = caption;
    listEl.innerHTML = '';
    if (!memories.length) { listEl.appendChild(h('div', { className: 'notes-memory-empty' }, 'Nothing remembered yet — as you write notes, durable facts and preferences will collect here.')); return; }
    for (const m of memories) listEl.appendChild(memoryRow(m));
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => void search(searchInput.value), 300); });

  void loadAll();
  return h('div', { className: 'notes-memory-panel' },
    h('p', { className: 'notes-memory-intro' }, 'This is your "second brain" — the durable facts, preferences and decisions the app has gathered from your notes over time. Search it, or forget anything you\'d rather it didn\'t keep. The remembering happens quietly in the background.'),
    searchInput,
    status,
    listEl,
  ) as HTMLElement;
}
