// SPDX-License-Identifier: MIT
/**
 * notes-quick-capture.ts — the global quick-capture box (weaveNotes Phase 8, desktop G8).
 *
 * A fast "jot a thought" overlay opened by a keyboard shortcut (⌘/Ctrl+Shift+K in the browser; the
 * Tauri desktop shell binds an OS-GLOBAL hotkey to the same action and emits a `quick-capture` event).
 * The typed text is parsed by the shared `parseQuickCapture` from `@weaveintel/notes` — first line →
 * title, a leading `/template` or `kind:` hint → a system template — and saved through the existing
 * create-note route (so a desktop capture lands stamped "on desktop" in the note's activity log).
 *
 * Presentational + self-contained: it owns its overlay and calls back with the new note id so the host
 * can open it.
 */
import { h } from './dom.js';
import { api } from './api.js';

/**
 * Create a note from a quick-capture blob. The raw text is parsed SERVER-SIDE (the shared
 * `parseQuickCapture` in @weaveintel/notes), so the title/body/template logic lives in one place and
 * the desktop "on desktop" provenance is recorded. Returns the new note id, or null on failure.
 */
export async function submitQuickCapture(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  try {
    const res = await api.post('/api/me/notes/quick-capture', { text });
    if (!res.ok) return null;
    const note = await res.json() as { id?: string };
    return note.id ?? null;
  } catch {
    return null;
  }
}

let _open = false;

/** Open the quick-capture overlay. `onCaptured(noteId)` fires after a successful save. */
export function openQuickCaptureModal(onCaptured: (noteId: string) => void): void {
  if (_open) return;
  _open = true;

  const input = h('textarea', {
    className: 'gw-qc-input',
    placeholder: 'Jot a thought…  (first line is the title — try "/meeting Q3 sync" or "todo: ship it")',
    rows: 4,
  }) as HTMLTextAreaElement;

  const hint = h('div', { className: 'gw-qc-hint' }, 'Enter to capture · Shift+Enter for a new line · Esc to close');
  const status = h('span', { className: 'gw-qc-status' }, '') as HTMLElement;

  const close = (): void => { _open = false; overlay.remove(); document.removeEventListener('keydown', onKey, true); };

  const capture = async (): Promise<void> => {
    const text = input.value;
    if (!text.trim()) { close(); return; }
    status.textContent = 'Capturing…';
    const id = await submitQuickCapture(text);
    if (id) { close(); onCaptured(id); }
    else { status.textContent = 'Could not capture — try again.'; }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void capture(); }
  };

  const overlay = h('div', { className: 'gw-qc-overlay', onClick: (e: Event) => { if (e.target === overlay) close(); } },
    h('div', { className: 'gw-qc-card' },
      h('div', { className: 'gw-qc-head' },
        h('span', { className: 'gw-qc-title' }, '⚡ Quick capture'),
        h('button', { className: 'gw-qc-x', onClick: close, title: 'Close' }, '×'),
      ),
      input,
      h('div', { className: 'gw-qc-foot' },
        hint,
        h('div', { className: 'gw-qc-actions' },
          status,
          h('button', { className: 'gw-qc-save', onClick: () => void capture() }, 'Capture'),
        ),
      ),
    ),
  ) as HTMLElement;

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => input.focus(), 30);
}

/**
 * Wire the quick-capture trigger: the in-app shortcut (⌘/Ctrl+Shift+K) plus the Tauri desktop shell's
 * OS-global hotkey (which emits a `quick-capture` event). Returns a cleanup function.
 */
export function wireQuickCapture(onCaptured: (noteId: string) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
      e.preventDefault();
      openQuickCaptureModal(onCaptured);
    }
  };
  document.addEventListener('keydown', onKey);

  // Desktop shell: listen for the global-hotkey event the Tauri main process emits.
  let unlistenTauri: (() => void) | undefined;
  const tauri = (window as unknown as Record<string, unknown>)['__TAURI__'] as { event?: { listen?: (name: string, cb: () => void) => Promise<() => void> } } | undefined;
  if (tauri?.event?.listen) {
    void tauri.event.listen('quick-capture', () => openQuickCaptureModal(onCaptured)).then((un) => { unlistenTauri = un; }).catch(() => {});
  }

  return () => { document.removeEventListener('keydown', onKey); if (unlistenTauri) unlistenTauri(); };
}
