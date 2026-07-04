/**
 * Scroll-position preservation across the full-DOM re-render (m144 / H14 — CLS).
 *
 * geneWeave's `render()` does `root.innerHTML = ''`, which resets every scroll container to the top — so the
 * notes list, admin tables and dashboard jump on any action (a layout shift / lost-place problem). The chat
 * transcript + sidebar already handle this with bespoke code; this GENERALISES it: any element tagged
 * `data-scroll-key` is snapshotted before the wipe and restored after — pinned to the bottom if the reader
 * was at the bottom (so a growing list keeps following), else put back at their exact offset.
 *
 * Handles render BURSTS (several renders before the restore rAF fires): while a restore is pending, capture
 * is skipped so a freshly-wiped scrollTop of 0 can't clobber the real saved position.
 *
 * NOTE: the arithmetic (captureScroll / resolveScrollTop) is the canonical, unit-tested @weaveintel/a11y
 * (scroll.ts). The raw-served UI can't bare-import a workspace package, so it's mirrored here; the package
 * tests are the spec.
 */

interface ScrollSnapshot { top: number; atBottom: boolean }
const AT_BOTTOM_THRESHOLD = 24;
function finite(n: unknown): number { return typeof n === 'number' && Number.isFinite(n) ? n : 0; }
function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = AT_BOTTOM_THRESHOLD): boolean {
  if (![scrollTop, scrollHeight, clientHeight].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  return scrollHeight - (scrollTop + clientHeight) <= Math.max(0, finite(threshold));
}
function captureOne(el: HTMLElement): ScrollSnapshot {
  return { top: Math.max(0, finite(el.scrollTop)), atBottom: isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight) };
}
function resolveScrollTop(saved: ScrollSnapshot | undefined, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, finite(scrollHeight) - finite(clientHeight));
  if (!saved) return 0;
  if (saved.atBottom) return max;
  return Math.max(0, Math.min(finite(saved.top), max));
}

const _saved: Record<string, ScrollSnapshot> = {};
let _restorePending = false;

/** Snapshot every `[data-scroll-key]` container. Call BEFORE `root.innerHTML = ''`. */
export function captureScrollState(root: ParentNode = document): void {
  if (_restorePending) return; // a restore hasn't applied yet — the live scrollTop is unreliable (burst)
  try {
    root.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
      const key = el.getAttribute('data-scroll-key');
      if (key) _saved[key] = captureOne(el);
    });
    _restorePending = true;
  } catch { /* best-effort */ }
}

/** Restore every `[data-scroll-key]` container to its saved position. Call AFTER the rebuild (in the rAF). */
export function restoreScrollState(root: ParentNode = document): void {
  try {
    root.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
      const key = el.getAttribute('data-scroll-key');
      if (key && _saved[key]) el.scrollTop = resolveScrollTop(_saved[key], el.scrollHeight, el.clientHeight);
    });
  } catch { /* best-effort */ }
  finally { _restorePending = false; }
}
