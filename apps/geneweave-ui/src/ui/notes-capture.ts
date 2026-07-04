// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 7 — the CAPTURE panel for the notes list.
 *
 * "Capture" means pulling content INTO your notes from the outside world. This panel
 * gives two quick on-ramps:
 *   • Daily jot — type a thought and it is appended to today's "Daily Jots — <date>"
 *     note (a running inbox you can triage later).
 *   • Clip a web page — paste a public URL and the server fetches it, extracts the
 *     readable article text, and saves it as a new note with a provenance header.
 *
 * (Run→note and email→note also exist as API endpoints; runs are captured from the
 * run view, email is an inbound integration.) The panel is intentionally tiny: capture
 * should be a two-second action so good ideas do not get lost.
 *
 * --- For someone new to this ---
 * Think of this as a quick "save it for later" box. The jot box is a sticky-note pad;
 * the clip box is a "read this page and keep a copy" button. Everything lands as a
 * normal note you can open, edit, and organise afterwards.
 */
import { h } from './dom.js';
import { api } from './api.js';

// Module-local UI state (persists across re-renders without touching global state).
let captureOpen = false;
let busy = false;
// The last status message + kind, so a successful capture's confirmation survives the
// re-render that refreshes the notes list (which rebuilds this whole panel from scratch).
let lastStatus = '';
let lastStatusKind: 'ok' | 'err' | '' = '';

/** Set a transient status message on the panel's status line (and remember it across renders). */
function setStatus(el: HTMLElement | null, msg: string, kind: 'ok' | 'err' | '' = ''): void {
  lastStatus = msg; lastStatusKind = kind;
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === 'ok' ? 'var(--accent)' : kind === 'err' ? '#dc2626' : 'var(--fg3)';
}

/**
 * Build the capture panel. `render` re-renders the notes view (e.g. after a capture so
 * the new note appears in the list); `reload` reloads the notes list from the server.
 */
export function renderCapturePanel(render: () => void, reload: () => Promise<void>): HTMLElement {
  // Collapsed: a single toggle button.
  if (!captureOpen) {
    return h('div', { className: 'notes-capture-bar' },
      h('button', {
        className: 'notes-capture-toggle',
        title: 'Capture a thought or clip a web page into your notes',
        onClick: () => { captureOpen = true; render(); },
      }, '✚ Capture'),
    );
  }

  const status = h('div', { className: 'notes-capture-status' }) as HTMLElement;
  // Restore any message from before the last re-render (e.g. a capture confirmation).
  if (lastStatus) setStatus(status, lastStatus, lastStatusKind);

  const jotBox = h('textarea', {
    className: 'notes-capture-jot',
    placeholder: 'Quick jot — a thought, a to-do, a link… (saved to today\'s daily note)',
    rows: 2,
  }) as HTMLTextAreaElement;

  const urlBox = h('input', {
    className: 'notes-capture-url',
    type: 'text',
    placeholder: 'https://… — clip a public web page into a note',
  }) as HTMLInputElement;

  async function doJot(): Promise<void> {
    const text = jotBox.value.trim();
    if (!text || busy) return;
    busy = true; setStatus(status, 'Saving jot…');
    try {
      const res = await api.post('/api/me/notes/jot', { text });
      if (res.ok) { jotBox.value = ''; setStatus(status, '✓ Added to today\'s daily note', 'ok'); await reload(); render(); }
      else { setStatus(status, `Could not save jot (${res.status})`, 'err'); }
    } catch { setStatus(status, 'Could not save jot', 'err'); }
    finally { busy = false; }
  }

  async function doClip(): Promise<void> {
    const url = urlBox.value.trim();
    if (!url || busy) return;
    busy = true; setStatus(status, 'Clipping page…');
    try {
      const res = await api.post('/api/me/notes/capture/web', { url });
      const data = await res.json().catch(() => ({})) as { title?: string; error?: string };
      if (res.ok) { urlBox.value = ''; setStatus(status, `✓ Clipped: ${data.title ?? 'page'}`, 'ok'); await reload(); render(); }
      else { setStatus(status, data.error ? `Could not clip: ${data.error}` : `Could not clip page (${res.status})`, 'err'); }
    } catch { setStatus(status, 'Could not clip page', 'err'); }
    finally { busy = false; }
  }

  return h('div', { className: 'notes-capture-bar notes-capture-open' },
    h('div', { className: 'notes-capture-head' },
      h('span', { className: 'notes-capture-title' }, '✚ Capture'),
      h('button', { className: 'notes-capture-close', title: 'Close', onClick: () => { captureOpen = false; render(); } }, '×'),
    ),
    h('div', { className: 'notes-capture-row' },
      jotBox,
      h('button', { className: 'notes-capture-btn', onClick: () => void doJot() }, 'Jot'),
    ),
    h('div', { className: 'notes-capture-row' },
      urlBox,
      h('button', { className: 'notes-capture-btn', onClick: () => void doClip() }, 'Clip'),
    ),
    status,
  );
}
