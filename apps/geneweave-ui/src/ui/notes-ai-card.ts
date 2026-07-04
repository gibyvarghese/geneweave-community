// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 2 — the AI SELECTION CARD (the headline feature ⭐).
 *
 * --- For someone new to this ---
 * Select some text in a note and a little "✦ Ask AI" pill appears next to it. Click it and a
 * floating card opens: type what you want ("make this clearer", "translate to French"), or tap a
 * chip (Rewrite / Shorten / Expand / Explain / Continue), or COLOUR the selection — pick a
 * highlighter, or ask the AI to "colour-code" the note by topic / importance / status /
 * sentiment. Whatever you choose becomes a SUGGESTION you accept or reject in the right rail —
 * the AI never changes your note on its own. Colours the AI picks are always from a pre-checked,
 * easy-to-read (WCAG-AA) palette, so nothing it does is ever unreadable.
 *
 * This module is pure DOM + fetch (no framework). It watches the editor for a text selection,
 * floats the card anchored to it (Floating-UI-style positioning by hand), calls the note AI
 * endpoints, and asks the host to refresh the suggestions panel when one is staged.
 */
import { h } from './dom.js';
import { api } from './api.js';

/** The four highlighter swatches (kept in sync with @weaveintel/notes HIGHLIGHTER_SWATCHES). */
const SWATCHES = [
  { key: 'amber', color: '#FAC775' },
  { key: 'pink', color: '#F4C0D1' },
  { key: 'teal', color: '#9FE1CB' },
  { key: 'blue', color: '#B5D4F4' },
];
const SCHEMES: Array<{ key: string; label: string }> = [
  { key: 'topic', label: 'by topic' },
  { key: 'importance', label: 'by importance' },
  { key: 'status', label: 'by status' },
  { key: 'sentiment', label: 'by sentiment' },
];

export interface SelectionCard { destroy(): void }

/**
 * Wire the floating AI selection card to a note editor.
 * @param opts.container    the editor mount element (selections inside it trigger the pill)
 * @param opts.noteId       the note being edited
 * @param opts.onSuggestion called after a suggestion is staged (host refreshes the panel)
 */
export function wireSelectionCard(opts: { container: HTMLElement; noteId: string; onSuggestion: () => void }): SelectionCard {
  const { container, noteId, onSuggestion } = opts;
  let pill: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let savedText = '';
  let savedRect: DOMRect | null = null;

  function clear(): void { pill?.remove(); pill = null; card?.remove(); card = null; }

  /** The current selection IF it is non-empty and inside the editor; else null. */
  function selectionInfo(): { text: string; rect: DOMRect } | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (text.length < 2) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { text, rect };
  }

  function showPill(): void {
    const info = selectionInfo();
    if (!info) { if (!card) clear(); return; }
    savedText = info.text; savedRect = info.rect;
    if (card) return; // card already open — leave it
    if (!pill) {
      pill = h('button', { className: 'notes-aicard-pill', title: 'Ask AI about the selection',
        onMouseDown: (e: MouseEvent) => { e.preventDefault(); openCard(); } },
        h('span', { className: 'notes-aicard-spark' }, '✦'), ' Ask AI') as HTMLElement;
      document.body.appendChild(pill);
    }
    position(pill, info.rect, 34);
  }

  function position(el: HTMLElement, rect: DOMRect, height: number): void {
    const top = rect.top - height - 8;
    el.style.position = 'fixed';
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 360)}px`;
    el.style.zIndex = '400';
  }

  let busy = false;
  function setBusy(b: boolean, msg = ''): void {
    busy = b;
    if (!card) return;
    card.querySelectorAll('button').forEach((btn) => { (btn as HTMLButtonElement).disabled = b; });
    const status = card.querySelector('.notes-aicard-status') as HTMLElement | null;
    if (status) status.textContent = msg;
  }

  async function send(path: string, body: Record<string, unknown>, label: string): Promise<void> {
    if (busy) return;
    setBusy(true, `AI is ${label}…`);
    try {
      const res = await api.post(`/api/me/notes/${noteId}/${path}`, body);
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; count?: number };
      if (!res.ok || data.ok === false) { setBusy(false, `Couldn’t: ${data.error ?? res.status}`); return; }
      setBusy(false, '✓ Suggestion ready — review it in the right rail →');
      onSuggestion();
      setTimeout(clear, 1400);
    } catch (e) { setBusy(false, 'Network error'); console.warn('[ai-card]', e); }
  }

  // Text actions map to the existing AI co-author endpoints (rewrite/continue/ask) + an instruction.
  const textAction = (action: string, instruction: string, label: string) =>
    () => void send(`ai/${action}`, { instruction, selectionText: savedText }, label);
  const highlight = (color: string) => () => void send('ai/highlight', { phrase: savedText, color }, 'highlighting');
  const colorize = (scheme: string) => () => void send('ai/colorize', { scheme }, 'colour-coding');
  // Phase 4 (creative expansion): the one-stop "Visualize" — the AI picks the kind (or you force it).
  // The /ai/visual endpoint routes per the tenant's configured mode for that kind (direct / agent /
  // supervisor — set in the Builder under weaveNotes → Action Routing). A realistic image is always
  // direct (its generate_image tool is intentionally not agent-registered — it costs money).
  const visualize = (kind: string) => () => {
    // "Real photo / image (web)" sources a free-to-use image from the web (Openverse/Wikimedia/…) with
    // attribution — far better than an AI-drawn blob for a real subject (an organ, a place, an object).
    if (kind === 'web') return void send('ai/find-image', { query: savedText || 'image for this note' }, 'finding a free image');
    return void send('ai/visual', { instruction: savedText || 'a visual for this note', kind },
      kind === 'image' ? 'generating an image' : kind === 'illustration' ? 'illustrating' : kind === 'diagram' ? 'drawing a diagram' : kind === 'ink' ? 'sketching' : 'visualizing');
  };

  function openCard(): void {
    if (!savedRect) return;
    pill?.remove(); pill = null;
    const promptInput = h('input', { className: 'notes-aicard-input', type: 'text',
      placeholder: 'Ask AI to do anything with this…',
      onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) void send('ai/rewrite', { instruction: v, selectionText: savedText }, 'working'); } },
    }) as HTMLInputElement;

    const chip = (label: string, onClick: () => void, cls = '') => h('button', { className: `notes-aicard-chip ${cls}`, onMouseDown: (e: MouseEvent) => { e.preventDefault(); onClick(); } }, label);

    const schemeSel = h('select', { className: 'notes-aicard-scheme' }, ...SCHEMES.map((s) => h('option', { value: s.key }, s.label))) as HTMLSelectElement;
    const visualSel = h('select', { className: 'notes-aicard-scheme' },
      h('option', { value: 'auto' }, 'auto (AI picks)'),
      h('option', { value: 'diagram' }, 'diagram'),
      h('option', { value: 'illustration' }, 'illustration'),
      h('option', { value: 'ink' }, 'sketch / ink'),
      h('option', { value: 'web' }, 'real photo (web, free)'),
      h('option', { value: 'image' }, 'image (AI, realistic)'),
    ) as HTMLSelectElement;

    // Per-user preferred LANGUAGE for sourced web images (default English; saved in the DB).
    const IMAGE_LANGS: Array<[string, string]> = [['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ar', 'Arabic'], ['hi', 'Hindi']];
    const langSel = h('select', { className: 'notes-aicard-scheme', title: 'Language for found images (saved to your account)' },
      ...IMAGE_LANGS.map(([code, name]) => h('option', { value: code }, name)),
    ) as HTMLSelectElement;
    // Load the saved preference, and persist any change.
    void api.get('/me/notes-image-language').then(async (r) => { try { const d = await r.json() as { language?: string }; if (d.language) langSel.value = d.language; } catch { /* default en */ } }).catch(() => {});
    langSel.onchange = () => void api.put('/me/notes-image-language', { language: langSel.value }).catch(() => {});

    card = h('div', { className: 'notes-aicard', onMouseDown: (e: MouseEvent) => e.stopPropagation() },
      h('div', { className: 'notes-aicard-prompt' }, h('span', { className: 'notes-aicard-spark' }, '✦'), promptInput),
      h('div', { className: 'notes-aicard-chips' },
        chip('Rewrite', textAction('rewrite', 'Rewrite this passage to be clearer.', 'rewriting')),
        chip('Shorten', textAction('rewrite', 'Make this passage more concise.', 'shortening')),
        chip('Expand', textAction('rewrite', 'Expand this passage with more detail.', 'expanding')),
        chip('Explain', textAction('ask', 'Explain this passage simply.', 'explaining')),
        chip('Continue', textAction('continue', '', 'continuing')),
      ),
      h('div', { className: 'notes-aicard-colors' },
        h('span', { className: 'notes-aicard-colorlabel' }, 'Highlight'),
        ...SWATCHES.map((s) => h('button', { className: 'notes-aicard-swatch', title: `Highlight ${s.key}`, style: { background: s.color }, onMouseDown: (e: MouseEvent) => { e.preventDefault(); highlight(s.color)(); } })),
        h('span', { className: 'notes-aicard-sep' }),
        h('span', { className: 'notes-aicard-colorlabel' }, 'Colour-code'),
        schemeSel,
        chip('Go', () => colorize(schemeSel.value)(), 'notes-aicard-go'),
      ),
      // Phase 4: the one-stop Visualize row — pick a kind (or Auto) → the AI draws it.
      // For a real web photo, a language selector (saved per-user) sets the image-label language.
      h('div', { className: 'notes-aicard-visual' },
        h('span', { className: 'notes-aicard-spark' }, '✦'),
        h('span', { className: 'notes-aicard-colorlabel' }, 'Visualize'),
        visualSel,
        h('span', { className: 'notes-aicard-colorlabel' }, 'lang'),
        langSel,
        chip('Draw', () => visualize(visualSel.value)(), 'notes-aicard-create'),
      ),
      h('div', { className: 'notes-aicard-status' }),
    ) as HTMLElement;
    document.body.appendChild(card);
    position(card, savedRect, card.offsetHeight || 150);
    setTimeout(() => promptInput.focus(), 0);
  }

  // Selection + dismissal listeners.
  const onUp = () => { if (!card) showPill(); };
  const onDocDown = (e: MouseEvent) => {
    if (card && !card.contains(e.target as Node)) clear();
    else if (pill && e.target !== pill && !pill.contains(e.target as Node)) { /* keep pill; selection handler manages it */ }
  };
  const onScroll = () => clear();
  container.addEventListener('mouseup', onUp);
  container.addEventListener('keyup', onUp);
  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('scroll', onScroll, true);

  return {
    destroy(): void {
      clear();
      container.removeEventListener('mouseup', onUp);
      container.removeEventListener('keyup', onUp);
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('scroll', onScroll, true);
    },
  };
}
