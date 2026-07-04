// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — the LIVE "proactive linking" bar.
 *
 * --- For someone new to this ---
 * As you write, the app quietly notices when you've typed the NAME of another note (but haven't
 * turned it into a link yet) and offers to connect them with one click. This makes your personal
 * knowledge graph build itself as a by-product of writing — instead of asking you to remember to
 * link things by hand.
 *
 * The bar sits just above the note body. It stays hidden until there's something worth linking, and
 * it only refreshes when you PAUSE typing (so it never gets in the way mid-sentence). Clicking "Link"
 * wraps the first plain mention in a `[[wiki-link]]` server-side (lossless — only that phrase changes)
 * and reloads the note so the link, and the matching backlink on the other note, both appear.
 *
 * It's gated by the workspace's "proactive linking" Builder dial: when that's off, the server returns
 * `disabled` and the bar simply never shows.
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface ProactiveLinksBar {
  /** Call on each local edit; schedules a debounced refresh once typing pauses. */
  noteEdited(): void;
  /** Re-fetch + re-render now (e.g. when the editor first mounts). */
  refresh(): Promise<void>;
  /** Stop timers + clear the bar. */
  destroy(): void;
}

interface LinkSuggestion { targetId: string; targetTitle: string; kind: 'mention' | 'related'; reason: string; weight: number }

const IDLE_MS = 2800; // refresh only after the user pauses typing this long

export function wireProactiveLinks(opts: { noteId: string; barEl: HTMLElement; onApplied: () => void }): ProactiveLinksBar {
  const { noteId, barEl, onApplied } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dismissed = false;     // hidden until the next edit after the user closes it
  let destroyed = false;

  barEl.style.display = 'none';
  barEl.className = 'notes-proactive-bar';

  async function applyLink(title: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true; btn.textContent = 'Linking…';
    try {
      const res = await api.post(`/api/me/notes/${noteId}/link-suggestions/apply`, { targetTitle: title });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; linked?: boolean };
      if (res.ok && data.ok && data.linked) { onApplied(); return; } // reload re-renders the bar
      btn.textContent = data.linked === false ? 'No plain mention' : 'Couldn’t link';
    } catch { btn.textContent = 'Error'; }
  }

  function renderChip(s: LinkSuggestion): HTMLElement {
    const btn = h('button', { className: 'notes-proactive-chip', title: `Link the first mention of “${s.targetTitle}” (${s.reason})` }, `🔗 ${s.targetTitle}`) as HTMLButtonElement;
    btn.addEventListener('click', () => void applyLink(s.targetTitle, btn));
    return btn;
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    let suggestions: LinkSuggestion[] = [];
    let disabled = false;
    try {
      const res = await api.get(`/api/me/notes/${noteId}/link-suggestions?max=5`);
      if (res.ok) { const d = await res.json() as { suggestions?: LinkSuggestion[]; disabled?: boolean }; suggestions = d.suggestions ?? []; disabled = !!d.disabled; }
    } catch { /* keep the bar hidden on error */ }
    // Only the high-confidence verbatim MENTIONS get a one-click link here (a "related" note has no
    // specific phrase to wrap). Related notes stay in the right-rail Connections panel.
    const mentions = suggestions.filter((s) => s.kind === 'mention');
    if (destroyed || disabled || dismissed || mentions.length === 0) { barEl.style.display = 'none'; barEl.innerHTML = ''; return; }

    barEl.innerHTML = '';
    barEl.appendChild(h('span', { className: 'notes-proactive-label' }, '💡 Link notes you mentioned:'));
    const chips = h('span', { className: 'notes-proactive-chips' }, ...mentions.map((s) => renderChip(s)));
    barEl.appendChild(chips);
    const close = h('button', { className: 'notes-proactive-dismiss', title: 'Dismiss (comes back as you keep writing)' }, '✕') as HTMLButtonElement;
    close.addEventListener('click', () => { dismissed = true; barEl.style.display = 'none'; });
    barEl.appendChild(close);
    barEl.style.display = '';
  }

  function noteEdited(): void {
    dismissed = false; // a fresh edit re-arms the bar
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void refresh(); }, IDLE_MS);
  }

  return {
    noteEdited,
    refresh,
    destroy() { destroyed = true; if (timer) clearTimeout(timer); barEl.style.display = 'none'; barEl.innerHTML = ''; },
  };
}
