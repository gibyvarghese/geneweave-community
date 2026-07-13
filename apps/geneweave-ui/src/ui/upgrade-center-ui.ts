// SPDX-License-Identifier: MIT
/**
 * GeneWeave — Upgrade Center UI.
 *
 * The operator-facing front end for the upgrade engine. A stepper drives the lifecycle endpoints that already
 * exist (check → preview → apply → verify), and a keyboard-driven Review queue resolves the records the apply
 * couldn't settle automatically. Rendered when an admin tab sets `customView = 'upgrade-center'`.
 *
 * It is a thin front end over endpoints that enforce their own platform-admin RBAC:
 *   • lifecycle   POST /admin/upgrade/check · /preview · /apply ; GET /admin/upgrade/status
 *   • review      GET /admin/upgrade/review · POST …/review/:id/resolve · …/review/bulk · …/review/:id/undo
 *
 * The review queue mirrors the design's keyboard model: j / k move the cursor, 1 keeps mine, 2 adopts incoming,
 * d defers, u undoes the last action; bulk actions never touch a P1 (the server enforces that too). Vanilla TS
 * + the `h()` DOM helper + the shared `api` client (which attaches the CSRF token), matching the other custom
 * views (realm-workbench, routing-simulator). No framework.
 */
import { h } from './dom.js';
import { api } from './api.js';
import { realmBadge, laggingBadge } from './realm-ui.js';

/** Realm families the "needs attention" report can scan (the drift-tracked built-ins). */
const ATTENTION_FAMILIES = [
  'prompts', 'skills', 'worker_agents', 'guardrails', 'tool_policies', 'routing_policies',
  'cost_policies', 'prompt_strategies', 'prompt_contracts', 'workflows',
] as const;

/** A review-queue item (a subset of the server's upgrade_details row). */
interface ReviewItem {
  id: string;
  family: string;
  logical_key: string;
  layer: string;
  disposition: string;
  priority: string;
  note: string | null;
}
interface ReviewQueue { items: ReviewItem[]; byPriority: Record<string, number>; byFamily: Record<string, number>; }

/** A "needs attention" entry: a drifted and/or version-lagging record. */
interface AttentionEntry { id: string; logicalKey: string; realm: string; state: string; currentVersion: number | null; latestVersion: number | null; lagging: boolean; }
interface AttentionReport { family: string; entries: AttentionEntry[]; count: number; }

/** Module-local state (rebuilt into the DOM on every `render()`), matching the other custom views' idiom. */
interface UCState {
  status: Record<string, unknown> | null;   // last check status
  preview: Record<string, unknown> | null;   // last preview (four layer cards)
  apply: Record<string, unknown> | null;     // last apply result
  queue: ReviewQueue | null;
  cursor: number;                            // selected review row
  lastResolved: string | null;              // detail id of the last resolve (for one-tap undo)
  attentionFamily: string;                  // the family the attention report is scanning
  attention: AttentionReport | null;
  busy: string;                              // a label while a request is in flight
  error: string | null;
}
const S: UCState = { status: null, preview: null, apply: null, queue: null, cursor: 0, lastResolved: null, attentionFamily: 'skills', attention: null, busy: '', error: null };

/** Priority → badge kind: P1 conflict/guardrail is a red 'diverged'; everything else amber 'stale'. */
function priorityBadge(priority: string): HTMLElement {
  return realmBadge(priority === 'P1' ? 'diverged' : 'stale', priority);
}

// ── lifecycle (the stepper) ───────────────────────────────────────────────────────────────────────────

/** Call one lifecycle endpoint, stash its JSON, and re-render. Errors surface in the banner, never throw. */
async function callLifecycle(kind: 'check' | 'preview' | 'apply' | 'status', render: () => void): Promise<void> {
  S.busy = kind; S.error = null; render();
  try {
    const resp = kind === 'status' ? await api.get('/admin/upgrade/status') : await api.post(`/admin/upgrade/${kind}`, {});
    const data = await resp.json() as Record<string, unknown>;
    if (kind === 'check' || kind === 'status') S.status = data;
    else if (kind === 'preview') S.preview = data;
    else if (kind === 'apply') { S.apply = data; await loadQueue(render); }
  } catch (err) {
    S.error = `${kind} failed: ${(err as Error).message}`;
  } finally {
    S.busy = ''; render();
  }
}

// ── review queue ──────────────────────────────────────────────────────────────────────────────────────

/** Load the current review queue and clamp the cursor into range. */
async function loadQueue(render: () => void): Promise<void> {
  S.busy = 'review'; render();
  try {
    const resp = await api.get('/admin/upgrade/review');
    S.queue = await resp.json() as ReviewQueue;
    if (S.cursor >= S.queue.items.length) S.cursor = Math.max(0, S.queue.items.length - 1);
  } catch (err) {
    S.error = `load review failed: ${(err as Error).message}`;
  } finally {
    S.busy = ''; render();
  }
}

/** Resolve the item under the cursor (or a given id) with an action, then reload the queue. */
async function resolveItem(action: 'keep' | 'adopt' | 'defer', render: () => void, detailId?: string, comment?: string): Promise<void> {
  const id = detailId ?? S.queue?.items[S.cursor]?.id;
  if (!id) return;
  S.busy = action; S.error = null; render();
  try {
    const resp = await api.post(`/admin/upgrade/review/${id}/resolve`, { action, ...(comment ? { comment } : {}) });
    const result = await resp.json() as { ok?: boolean; reason?: string };
    if (result.ok) S.lastResolved = id; else S.error = result.reason ?? 'resolve failed';
  } catch (err) {
    S.error = `${action} failed: ${(err as Error).message}`;
  }
  await loadQueue(render);
}

/** Undo the last resolved item (re-open it; an adopt is reverted server-side). */
async function undoLast(render: () => void): Promise<void> {
  if (!S.lastResolved) return;
  const id = S.lastResolved;
  S.busy = 'undo'; render();
  try {
    await api.post(`/admin/upgrade/review/${id}/undo`, {});
    S.lastResolved = null;
  } catch (err) {
    S.error = `undo failed: ${(err as Error).message}`;
  }
  await loadQueue(render);
}

/** Bulk-resolve every non-P1 item of one family with an action (the server drops any P1 that slips through). */
async function bulkResolve(action: 'keep' | 'adopt' | 'defer', family: string | undefined, render: () => void): Promise<void> {
  S.busy = 'bulk'; S.error = null; render();
  try {
    await api.post('/admin/upgrade/review/bulk', { action, ...(family ? { family } : {}) });
  } catch (err) {
    S.error = `bulk failed: ${(err as Error).message}`;
  }
  await loadQueue(render);
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────────

/** A single review row. The selected row (`cursor`) gets an `is-cursor` class the keyboard handler tracks. */
function renderReviewRow(item: ReviewItem, index: number, render: () => void): HTMLElement {
  const selected = index === S.cursor;
  const row = h('div', {
    className: `uc-review-row${selected ? ' is-cursor' : ''}`,
    'data-uc-review-item': item.id,
    'data-priority': item.priority,
    onclick: () => { S.cursor = index; render(); },
  },
    priorityBadge(item.priority),
    realmBadge('stale', item.disposition),
    h('span', { className: 'uc-family' }, item.family),
    h('span', { className: 'uc-key' }, item.logical_key),
    h('span', { className: 'uc-note' }, item.note ?? ''),
    h('div', { className: 'uc-row-actions' },
      h('button', { 'data-uc-action': 'keep', onclick: (e: Event) => { e.stopPropagation(); void resolveItem('keep', render, item.id); } }, 'Keep mine'),
      h('button', { 'data-uc-action': 'adopt', onclick: (e: Event) => { e.stopPropagation(); void resolveItem('adopt', render, item.id); } }, 'Adopt'),
      h('button', { 'data-uc-action': 'defer', onclick: (e: Event) => { e.stopPropagation(); void resolveItem('defer', render, item.id); } }, 'Defer'),
    ),
  );
  return row;
}

/** The whole review section: tally, bulk controls, the keyboard-navigable list, and the undo affordance. */
function renderReview(render: () => void): HTMLElement {
  const q = S.queue;
  const remaining = q?.items.length ?? 0;
  const section = h('div', { className: 'uc-review', tabindex: '0', 'data-uc-review': '' },
    h('div', { className: 'uc-review-head' },
      h('strong', {}, 'Review queue'),
      h('span', { className: 'uc-remaining', 'data-uc-remaining': String(remaining) }, remaining === 0 ? 'All clear ✓' : `${remaining} to review`),
      h('button', { 'data-uc-bulk': 'keep', onclick: () => void bulkResolve('keep', undefined, render) }, 'Keep-mine all (non-P1)'),
      h('button', { 'data-uc-undo': '', disabled: !S.lastResolved, onclick: () => void undoLast(render) }, 'Undo'),
    ),
    h('div', { className: 'uc-hint' }, 'j/k move · 1 keep · 2 adopt · d defer · u undo — P1 items are never bulk-resolved'),
    ...(remaining === 0
      ? [h('div', { className: 'uc-empty' }, 'Nothing to review.')]
      : (q!.items.map((it, i) => renderReviewRow(it, i, render)))),
  );
  // Move the cursor highlight IN PLACE (no full re-render), so the container keeps focus — a full rebuild on
  // every keystroke drops focus until an async refocus, which races rapid key presses.
  const moveCursor = (delta: number): void => {
    const n = S.queue?.items.length ?? 0;
    S.cursor = Math.max(0, Math.min(n - 1, S.cursor + delta));
    section.querySelectorAll('.uc-review-row').forEach((el, i) => (el as HTMLElement).classList.toggle('is-cursor', i === S.cursor));
  };
  // Keyboard model: j/k move the cursor, 1/2/d act on it, u undoes. Keys not handled fall through.
  section.addEventListener('keydown', (e: KeyboardEvent) => {
    const n = S.queue?.items.length ?? 0;
    if (n === 0 && e.key !== 'u') return;
    if (e.key === 'j') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'k') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === '1') { e.preventDefault(); void resolveItem('keep', render); }
    else if (e.key === '2') { e.preventDefault(); void resolveItem('adopt', render); }
    else if (e.key === 'd') { e.preventDefault(); void resolveItem('defer', render); }
    else if (e.key === 'u') { e.preventDefault(); void undoLast(render); }
    else return;
  });
  return section;
}

// ── needs attention ─────────────────────────────────────────────────────────────────────────────────────

/** Load the "needs attention" report for the selected family. */
async function loadAttention(render: () => void): Promise<void> {
  S.busy = 'attention'; S.error = null; render();
  try {
    const resp = await api.get(`/admin/upgrade/attention?family=${encodeURIComponent(S.attentionFamily)}`);
    S.attention = await resp.json() as AttentionReport;
  } catch (err) {
    S.error = `attention failed: ${(err as Error).message}`;
  } finally {
    S.busy = ''; render();
  }
}

/** The "needs attention" section: a family picker + the drifted/lagging records with drift + lagging badges. */
function renderAttention(render: () => void): HTMLElement {
  const rep = S.attention;
  return h('div', { className: 'uc-attention', 'data-uc-attention': '' },
    h('div', { className: 'uc-review-head' },
      h('strong', {}, 'Needs attention'),
      h('select', {
        'data-uc-attention-family': '', value: S.attentionFamily,
        onchange: (e: Event) => { S.attentionFamily = (e.target as HTMLSelectElement).value; void loadAttention(render); },
      }, ...ATTENTION_FAMILIES.map((f) => h('option', { value: f, selected: f === S.attentionFamily }, f))),
      h('button', { 'data-uc-attention-load': '', onclick: () => void loadAttention(render) }, 'Scan'),
      rep ? h('span', { className: 'uc-remaining', 'data-uc-attention-count': String(rep.count) }, `${rep.count} need attention`) : null,
    ),
    ...(rep
      ? (rep.entries.length === 0
          ? [h('div', { className: 'uc-empty' }, `Nothing in ${rep.family} needs attention.`)]
          : rep.entries.map((e) => h('div', { className: 'uc-review-row', 'data-uc-attention-item': e.logicalKey },
              realmBadge(e.state === 'diverged' ? 'diverged' : e.state === 'customized' ? 'customized' : 'stale', e.state),
              h('span', { className: 'uc-key' }, e.logicalKey),
              laggingBadge(e.currentVersion ?? 0, e.latestVersion ?? 0) ?? h('span', {}, ''),
            )))
      : [h('div', { className: 'uc-hint' }, 'Pick a family and Scan to see drifted or version-lagging records.')]),
  );
}

/** Refocus the review container after a re-render so keyboard navigation keeps working. */
function focusReview(): void {
  const el = document.querySelector('[data-uc-review]') as HTMLElement | null;
  el?.focus();
}

/** A lifecycle step button. */
function stepButton(label: string, kind: 'check' | 'preview' | 'apply', render: () => void): HTMLElement {
  return h('button', {
    className: 'uc-step', 'data-uc-step': kind, disabled: !!S.busy,
    onclick: () => void callLifecycle(kind, render),
  }, S.busy === kind ? `${label}…` : label);
}

/** One preview layer card (L1–L4) with its headline count. */
function layerCard(title: string, detail: string): HTMLElement {
  return h('div', { className: 'uc-layer-card' }, h('div', { className: 'uc-layer-title' }, title), h('div', { className: 'uc-layer-detail' }, detail));
}

/** Render the four preview layer cards from the last preview result. */
function renderLayers(): HTMLElement | null {
  const p = S.preview as { layers?: { L1?: { stale?: unknown[] }; L2?: { repoTag?: string | null }; L3?: { toRun?: unknown[] }; L4?: { entries?: unknown[] } } } | null;
  if (!p?.layers) return null;
  const { L1, L2, L3, L4 } = p.layers;
  return h('div', { className: 'uc-layers', 'data-uc-layers': '' },
    layerCard('L1 · packages', `${L1?.stale?.length ?? 0} stale`),
    layerCard('L2 · code', L2?.repoTag ? `deploy ${L2.repoTag}` : 'no change'),
    layerCard('L3 · schema', `${L3?.toRun?.length ?? 0} to run`),
    layerCard('L4 · content', `${L4?.entries?.length ?? 0} changes`),
  );
}

/**
 * Mount the Upgrade Center. Loads the last check status + the review queue on first render.
 * @param options.render the injected full re-render callback (the custom-view contract).
 * @returns the view's root element.
 */
export function renderUpgradeCenterView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  // First mount: pull the current status + any outstanding review items.
  if (S.status === null && !S.busy) { void callLifecycle('status', render); void loadQueue(render); }

  const root = h('div', { className: 'uc-root', 'data-upgrade-center': '' },
    h('h2', { style: 'margin:0 0 4px;' }, 'Upgrade Center'),
    S.error ? h('div', { className: 'uc-error', 'data-uc-error': '' }, S.error) : null,
    h('div', { className: 'uc-stepper' },
      stepButton('Check', 'check', render),
      stepButton('Preview', 'preview', render),
      stepButton('Apply', 'apply', render),
    ),
    renderLayers(),
    renderReview(render),
    renderAttention(render),
  );
  // Auto-focus the review queue so the keyboard model works immediately (and for the E2E).
  setTimeout(focusReview, 0);
  return root;
}
