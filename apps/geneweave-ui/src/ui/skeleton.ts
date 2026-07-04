/**
 * Loading skeletons (m144 — CLS / perceived performance).
 *
 * A slow view used to flash a blank area or a bare "Loading…" and then JUMP when the data arrived (a layout
 * shift). A skeleton shows placeholder shapes roughly the size of the real content, so the page settles once
 * and feels faster. Shimmer respects reduced-motion (the global `html[data-reduced-motion]` rule stills it),
 * and a workspace can turn skeletons off (then we fall back to a plain, accessible "Loading…" status).
 *
 * Every skeleton carries `role="status"` + an accessible label so a screen reader is told the view is loading
 * (the decorative bars themselves are `aria-hidden`).
 */
import { h } from './dom.js';

let _showSkeletons = true;
export function setShowSkeletons(on: boolean): void { _showSkeletons = on; }
export function skeletonsEnabled(): boolean { return _showSkeletons; }

function bars(...widths: string[]): HTMLElement {
  return h('div', { className: 'skel-lines', 'aria-hidden': 'true' }, ...widths.map((w) => h('div', { className: `skel-line ${w}` })));
}

/** A vertical list of placeholder rows (for the notes list, an admin record list, etc.). */
export function skeletonList(rows = 7): HTMLElement {
  const wrap = h('div', { className: 'skel', role: 'status', 'aria-label': 'Loading…' });
  for (let i = 0; i < rows; i++) wrap.appendChild(h('div', { className: 'skel-row' }, h('div', { className: 'skel-dot', 'aria-hidden': 'true' }), bars('w70', 'w40')));
  return wrap;
}

/** A grid of placeholder cards (for the dashboard). */
export function skeletonCards(n = 4): HTMLElement {
  const grid = h('div', { className: 'skel-grid', role: 'status', 'aria-label': 'Loading…' });
  for (let i = 0; i < n; i++) grid.appendChild(h('div', { className: 'skel-card' }, bars('w50'), h('div', { className: 'skel-line skel-big', 'aria-hidden': 'true' }), bars('w80', 'w30')));
  return grid;
}

/** A loading placeholder for a view: a skeleton when enabled, else a plain accessible "Loading…" status. */
export function loadingPlaceholder(kind: 'list' | 'cards' = 'list', fallbackText = 'Loading…'): HTMLElement {
  if (!_showSkeletons) return h('div', { className: 'skel-fallback', role: 'status' }, fallbackText);
  return kind === 'cards' ? skeletonCards() : skeletonList();
}
