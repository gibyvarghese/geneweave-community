/**
 * Focus preservation across the full-DOM re-render (m141 / H13) — the chat-side glue.
 *
 * geneWeave's `render()` does `root.innerHTML = ''`, which DESTROYS keyboard focus: after any action a
 * keyboard or screen-reader user is dumped back to the top of the page (WCAG 2.4.3). This captures a stable
 * key for the focused control BEFORE the rebuild and restores focus (and text-caret position) to the matching
 * element AFTER — so your place is never lost.
 *
 * NOTE: the canonical, unit-tested version of these key helpers lives in `@weaveintel/a11y` (focus.ts). The
 * raw-served browser modules can't bare-import a workspace package (only the notes editor is bundled), so we
 * mirror the same pure logic here; the package tests are the spec — keep the two in sync.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
function cssEscapeValue(s: string): string {
  return String(s).replace(CONTROL_CHARS, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function captureFocusKey(d: { focusKey?: string | null; id?: string | null }): string | null {
  const key = typeof d.focusKey === 'string' ? d.focusKey.trim() : '';
  if (key) return `k:${key}`;
  const id = typeof d.id === 'string' ? d.id.trim() : '';
  if (id) return `i:${id}`;
  return null;
}
function focusSelector(key: string): string | null {
  if (typeof key !== 'string') return null;
  const sep = key.indexOf(':');
  if (sep < 0) return null;
  const kind = key.slice(0, sep);
  const val = key.slice(sep + 1);
  if (!val) return null;
  if (kind === 'k') return `[data-focus-key="${cssEscapeValue(val)}"]`;
  if (kind === 'i') return `[id="${cssEscapeValue(val)}"]`;
  return null;
}

export interface SavedFocus { key: string; selStart: number | null; selEnd: number | null }

/** Snapshot the currently-focused control (if it's one we can reliably re-find). Call BEFORE the re-render. */
export function captureFocus(): SavedFocus | null {
  try {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const key = captureFocusKey({ focusKey: el.getAttribute('data-focus-key'), id: el.id });
    if (!key) return null;
    let selStart: number | null = null;
    let selEnd: number | null = null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try { selStart = el.selectionStart; selEnd = el.selectionEnd; } catch { /* some input types disallow selection */ }
    }
    return { key, selStart, selEnd };
  } catch { return null; }
}

/**
 * Restore focus to the saved control after the re-render. Conservative: only acts if focus was actually lost
 * to the document body (so it never overrides an intentional focus move made during render, e.g. an overlay
 * returning focus to its trigger).
 */
export function restoreFocus(saved: SavedFocus | null, root: ParentNode = document): void {
  if (!saved) return;
  try {
    const cur = document.activeElement;
    if (cur && cur !== document.body) return; // focus already went somewhere on purpose — leave it
    const sel = focusSelector(saved.key);
    if (!sel) return;
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.focus();
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && saved.selStart != null) {
      try { el.setSelectionRange(saved.selStart, saved.selEnd ?? saved.selStart); } catch { /* */ }
    }
  } catch { /* focus restoration is best-effort */ }
}

/** Apply the workspace "always show focus outlines" default (forces rings even for mouse users). */
export function applyForceFocusRing(on: boolean): void {
  try {
    if (on) document.documentElement.setAttribute('data-force-focus-ring', '1');
    else document.documentElement.removeAttribute('data-force-focus-ring');
  } catch { /* */ }
}
