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
import { mountCodeMergeEditor, type CodeMergeEditorHandle } from './code-merge-editor.js';

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

/** An unresolved L2 code conflict (a file both the operator and the release changed). */
interface CodeConflictItem { detailId: string; path: string; priority: string; }
/** The three text sides + base-informed pre-merge for one conflicted file (or a git_required marker). */
interface CodeConflictContent { path: string; base: string; local: string; remote: string; merged: string; clean: boolean; }
/** The conflict currently open in the merge editor (or a `gitRequired` reason to resolve on the branch). */
type CodeOpen = { detailId: string; path: string; remote: string; merged: string; gitRequired?: string };

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
  codeConflicts: CodeConflictItem[] | null;  // the L2 code-conflict work list (null until loaded)
  codeOpen: CodeOpen | null;                 // the conflict currently open in the merge editor
  busy: string;                              // a label while a request is in flight
  error: string | null;
}
const S: UCState = { status: null, preview: null, apply: null, queue: null, cursor: 0, lastResolved: null, attentionFamily: 'skills', attention: null, codeConflicts: null, codeOpen: null, busy: '', error: null };

/** The live merge-editor instance (a real object, not serialisable state — kept out of `S`). */
let codeEditor: CodeMergeEditorHandle | null = null;

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

// ── L2 code conflicts (the in-app @codemirror/merge view) ──────────────────────────────────────────────

/** Run a three-way scan against the accepted release's git refs (records real conflicts), then reload the list. */
async function scanRelease(render: () => void): Promise<void> {
  S.busy = 'code-scan'; S.error = null; render();
  try {
    const resp = await api.post('/admin/upgrade/code/scan-release', {});
    const data = await resp.json() as { status?: string; reason?: string; recorded?: number };
    if (data.status === 'git_required') S.error = `Release scan unavailable: ${data.reason}. Resolve on the upgrade/v<target> git branch.`;
  } catch (err) {
    S.error = `scan failed: ${(err as Error).message}`;
  } finally {
    S.busy = '';
  }
  await loadCodeConflicts(render); // reload the list (manages its own busy/render)
}

/** Load the unresolved code conflicts an upgrade left for a merge decision. */
async function loadCodeConflicts(render: () => void): Promise<void> {
  S.busy = 'code'; S.error = null; render();
  try {
    const resp = await api.get('/admin/upgrade/code/conflicts');
    if (!resp.ok) {
      // A non-2xx (e.g. 429 rate-limited, 501 unsupported) returns an error body, not { conflicts } — surface it
      // and default to an empty list so the section renders instead of throwing on `.length`.
      S.error = `load code conflicts failed (${resp.status})`;
      S.codeConflicts = S.codeConflicts ?? [];
    } else {
      const data = await resp.json() as { conflicts?: CodeConflictItem[] };
      S.codeConflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    }
  } catch (err) {
    S.error = `load code conflicts failed: ${(err as Error).message}`;
    S.codeConflicts = S.codeConflicts ?? [];
  } finally {
    S.busy = ''; render();
  }
}

/** Open one conflict in the merge editor. A git_required response degrades to a "resolve on the branch" note. */
async function openConflict(item: CodeConflictItem, render: () => void): Promise<void> {
  S.busy = 'code'; S.error = null; render();
  try {
    const resp = await api.get(`/admin/upgrade/code/conflict?path=${encodeURIComponent(item.path)}`);
    const data = await resp.json() as CodeConflictContent | { status: 'git_required'; reason: string };
    S.codeOpen = 'status' in data && data.status === 'git_required'
      ? { detailId: item.detailId, path: item.path, remote: '', merged: '', gitRequired: data.reason }
      : { detailId: item.detailId, path: item.path, remote: (data as CodeConflictContent).remote, merged: (data as CodeConflictContent).merged };
  } catch (err) {
    S.error = `open conflict failed: ${(err as Error).message}`;
  } finally {
    S.busy = ''; render();
  }
}

/** Tear down the editor + close the merge panel. */
function closeConflict(render: () => void): void {
  if (codeEditor) { codeEditor.destroy(); codeEditor = null; }
  S.codeOpen = null; render();
}

/** Submit the operator's resolution. The server refuses text still carrying markers (surfaced in the banner). */
async function submitConflict(render: () => void): Promise<void> {
  const o = S.codeOpen;
  if (!o || o.gitRequired) return;
  const content = codeEditor ? codeEditor.getResolved() : o.merged;
  S.busy = 'code'; S.error = null; render();
  try {
    const resp = await api.post('/admin/upgrade/code/conflict/resolve', { detailId: o.detailId, path: o.path, content });
    const res = await resp.json() as { ok?: boolean; reason?: string };
    if (res.ok) {
      if (codeEditor) { codeEditor.destroy(); codeEditor = null; }
      S.codeOpen = null;
      await loadCodeConflicts(render);
    } else {
      S.error = res.reason === 'unresolved_markers'
        ? 'Still has conflict markers — resolve every <<<<<<< / ======= / >>>>>>> before applying.'
        : (res.reason ?? 'resolve failed');
    }
  } catch (err) {
    S.error = `resolve failed: ${(err as Error).message}`;
  } finally {
    S.busy = ''; render();
  }
}

/** The open conflict's merge panel: labels + the editor mount point + apply/cancel (or the git-required note). */
function renderMergePanel(render: () => void): HTMLElement {
  const o = S.codeOpen!;
  if (o.gitRequired) {
    return h('div', { className: 'uc-merge-panel', 'data-uc-merge-git': '' },
      h('div', { className: 'uc-merge-head' }, h('strong', {}, o.path), h('button', { onclick: () => closeConflict(render) }, 'Close')),
      h('div', { className: 'uc-hint' }, `In-app merge unavailable: ${o.gitRequired}. Resolve it on the upgrade/v<target> git branch instead.`),
    );
  }
  return h('div', { className: 'uc-merge-panel', 'data-uc-merge': '', role: 'region', 'aria-label': `Merge ${o.path}` },
    h('div', { className: 'uc-merge-head' },
      h('strong', {}, o.path),
      h('span', { className: 'uc-merge-label' }, '◀ Incoming (read-only) · Your resolution (editable) ▶'),
      // Live unresolved-conflict count (updated in place by the editor's onChange — see mountPendingMerge).
      h('span', { className: 'uc-merge-count', 'data-uc-merge-count': '', role: 'status', 'aria-live': 'polite' }, 'Loading…'),
      h('button', { 'data-uc-merge-next': '', title: 'Jump to the next remaining conflict', onclick: () => codeEditor?.gotoNextConflict() }, 'Next conflict'),
      // Apply starts disabled and is enabled only when no conflict markers remain (set live in mountPendingMerge).
      h('button', { 'data-uc-merge-apply': '', disabled: true, onclick: () => void submitConflict(render) }, 'Apply resolution'),
      h('button', { 'data-uc-merge-cancel': '', onclick: () => closeConflict(render) }, 'Cancel'),
    ),
    // The merge editor mounts into this container after render (setTimeout in the view root).
    h('div', { className: 'uc-merge-mount', 'data-uc-merge-mount': '', role: 'group', 'aria-label': 'Three-way code merge editor' }, 'Loading editor…'),
  );
}

/** The Code section: a Load button, the conflict list, and (when one is open) the merge panel. */
function renderCode(render: () => void): HTMLElement {
  const list = S.codeConflicts;
  return h('div', { className: 'uc-code', 'data-uc-code': '' },
    h('div', { className: 'uc-review-head' },
      h('strong', {}, 'Code conflicts (L2)'),
      h('button', { 'data-uc-code-load': '', onclick: () => void loadCodeConflicts(render) }, 'Load'),
      h('button', { 'data-uc-code-scan': '', disabled: !!S.busy, onclick: () => void scanRelease(render) }, S.busy === 'code-scan' ? 'Scanning…' : 'Scan release'),
      list ? h('span', { className: 'uc-remaining' }, `${list.length} file${list.length === 1 ? '' : 's'}`) : null,
    ),
    ...(!list
      ? [h('div', { className: 'uc-hint' }, 'Load the code files an upgrade left conflicting for a merge decision.')]
      : list.length === 0
        ? [h('div', { className: 'uc-empty' }, 'No code conflicts.')]
        : list.map((it) => h('div', { className: 'uc-review-row', 'data-uc-code-item': it.path },
            priorityBadge(it.priority),
            h('span', { className: 'uc-key' }, it.path),
            h('div', { className: 'uc-row-actions' }, h('button', { 'data-uc-code-open': '', onclick: () => void openConflict(it, render) }, 'Open merge')),
          ))),
    S.codeOpen ? renderMergePanel(render) : null,
  );
}

/** After a render, mount the CodeMirror merge editor into the open conflict's placeholder (idempotent). */
function mountPendingMerge(): void {
  if (!S.codeOpen || S.codeOpen.gitRequired || codeEditor) return;
  const mount = document.querySelector('[data-uc-merge-mount]') as HTMLElement | null;
  if (!mount) return;
  // Reflect the live unresolved-conflict count into the header WITHOUT a full re-render (which would destroy the
  // editor + lose the operator's place): update the count text + Apply-button enabled state in place.
  const reflect = (unresolved: number): void => {
    const apply = document.querySelector('[data-uc-merge-apply]') as HTMLButtonElement | null;
    if (apply) apply.disabled = unresolved > 0;
    const count = document.querySelector('[data-uc-merge-count]') as HTMLElement | null;
    if (count) count.textContent = unresolved === 0 ? 'No conflicts — ready to apply ✓' : `${unresolved} conflict${unresolved === 1 ? '' : 's'} left`;
  };
  void mountCodeMergeEditor({ container: mount, remote: S.codeOpen.remote, merged: S.codeOpen.merged, onChange: reflect })
    .then((handle) => { codeEditor = handle; reflect(handle.unresolvedCount()); }) // set the initial count/gate
    .catch((err: unknown) => { mount.textContent = `editor failed to load: ${(err as Error).message}`; });
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
  // A full re-render replaces the whole DOM (destroying the editor's nodes). If a merge editor is live, capture
  // its in-progress text into `codeOpen.merged` and dispose it BEFORE the rebuild, so the post-render re-mount
  // restores the operator's unsaved resolution rather than resetting it.
  if (codeEditor) {
    try { if (S.codeOpen) S.codeOpen = { ...S.codeOpen, merged: codeEditor.getResolved() }; } catch { /* editor gone */ }
    codeEditor.destroy(); codeEditor = null;
  }
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
    renderCode(render),
    renderAttention(render),
  );
  // Auto-focus the review queue so the keyboard model works immediately (and for the E2E); then (re-)mount the
  // merge editor into the open conflict's placeholder, restoring any captured in-progress text.
  setTimeout(focusReview, 0);
  setTimeout(mountPendingMerge, 0);
  return root;
}
