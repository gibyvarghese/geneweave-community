// SPDX-License-Identifier: MIT
/**
 * GeneWeave — Tenancy Realm workbench UI.
 *
 * The operator-facing front end for the realm. Everything the realm could already do over the admin API
 * — see what has drifted, three-way merge a `diverged` record, turn a shared default off for one tenant,
 * pin a version, preview a share's blast radius — now has a screen. Rendered when an admin tab sets
 * `customView = 'realm-workbench'`.
 *
 * Three sections, each a thin front end over endpoints that already exist and enforce their own RBAC:
 *   • Drift & merge   GET /admin/realm/:family/drift · GET …/:id/diff · POST …/:id/merge
 *   • State overlay   GET/PUT/DEL /admin/realm-state · POST/DEL /admin/realm/guardrails/profile/lean
 *   • Share & reach   GET /admin/prompts/:id/blast-radius · POST /admin/prompts/:id/share
 *
 * Vanilla TS + the `h()` DOM helper + the shared `api` client (which attaches the CSRF token), matching
 * the other custom views (routing-simulator, capability-matrix). No framework.
 */
import { h } from './dom.js';
import { api } from './api.js';

/** The realm-enabled families, in the order they appear in the family picker. */
const FAMILIES = [
  'prompts', 'prompt_fragments', 'skills', 'worker_agents', 'guardrails', 'tool_policies',
  'routing_policies', 'cost_policies', 'prompt_strategies', 'prompt_contracts', 'prompt_frameworks',
] as const;

// ── shared badge ────────────────────────────────────────────────────────────

/**
 * A provenance / drift badge. Amber ("shared"/"inherited"/"stale") flags a copy reaching down the org
 * tree or a default that has moved on; blue ("own"/"customized") a tenant's own edit; red a conflict or
 * a deprecation. Exported so admin list rows can show it too, not just the workbench.
 */
export function realmBadge(kind: string, label?: string): HTMLElement {
  const text = label ?? kind.replace(/_/g, ' ');
  return h('span', { className: `realm-badge ${kind}`, title: `realm: ${kind}` }, text);
}

/**
 * The badge for a raw admin-list row, from its realm columns. A tenant copy shared down the tree reads
 * "shared" (amber); a private tenant copy reads "tenant"; a deprecated global reads "deprecated"; a plain
 * global gets a quiet "global". Used by the admin list cell renderer so realm status is visible in place.
 */
export function realmCellBadge(row: Record<string, unknown>): HTMLElement {
  if (row['deprecated_at']) return realmBadge('deprecated', 'deprecated');
  const realm = String(row['realm'] ?? 'global');
  if (realm === 'tenant') {
    const share = String(row['share_mode'] ?? 'private');
    return share === 'children' || share === 'subtree' ? realmBadge('shared', 'shared') : realmBadge('own', 'tenant');
  }
  return realmBadge('global', 'global');
}

/**
 * The lagging-version badge: an amber "v{current} · v{latest} available" for a built-in that trails the
 * shipped default (its live version is behind the latest published one). Returns null when it's current, so
 * a caller can drop it into any admin list cell and only see it when the record actually lags. The Upgrade
 * Center's adopt clears the lag; an undo brings it back — the badge tracks the truth either way.
 */
export function laggingBadge(current: number, latest: number): HTMLElement | null {
  if (!Number.isFinite(current) || !Number.isFinite(latest) || current >= latest) return null;
  return realmBadge('lagging', `v${current} · v${latest} available`);
}

/** Map a provenance `kind` (from a `/realm` endpoint) to a badge, or null for the plain global. */
export function provenanceBadge(kind: string | undefined): HTMLElement | null {
  if (!kind || kind === 'global') return null;
  if (kind === 'own_override') return realmBadge('own', 'your copy');
  if (kind === 'inherited') return realmBadge('inherited', 'shared');
  if (kind === 'native') return realmBadge('own', 'tenant');
  return realmBadge(kind);
}

// ── module state ────────────────────────────────────────────────────────────

interface DiffField { field: string; base: unknown; local: unknown; remote: unknown; status: string; resolved?: unknown }
interface ThreeWayDiff {
  family: string; recordId: string; logicalKey: string; realm: string; ownerTenantId: string | null;
  drift: string; baseAvailable: boolean; fields: DiffField[]; conflicts: string[];
  hashes: { base: string | null; local: string; remote: string | null };
}
interface DriftEntry { id: string; logicalKey: string; realm: string; ownerTenantId: string | null; state: string }

interface RealmState {
  section: 'drift' | 'overlay' | 'share';
  family: string;
  tenantId: string;
  // drift
  drift: DriftEntry[] | null; driftLoading: boolean; driftError: string;
  openDiff: ThreeWayDiff | null; diffLoading: boolean;
  resolved: Record<string, string>;           // conflict field → operator-entered value
  mergeMsg: { ok: boolean; text: string } | null;
  // overlay
  overlayRows: Array<Record<string, unknown>> | null; overlayLoading: boolean; overlayError: string;
  overlayStates: Record<string, { enabled: boolean | null; priority: number | null; pinnedVersion: number | null }>;
  overlayMsg: { ok: boolean; text: string } | null;
  // share
  sharePromptId: string; shareMode: string;
  blast: { inheriting: string[]; shadowed: string[]; outOfScope: number } | null; shareMsg: { ok: boolean; text: string } | null;
}

const S: RealmState = {
  section: 'drift', family: 'prompts', tenantId: '',
  drift: null, driftLoading: false, driftError: '', openDiff: null, diffLoading: false, resolved: {}, mergeMsg: null,
  overlayRows: null, overlayLoading: false, overlayError: '', overlayStates: {}, overlayMsg: null,
  sharePromptId: '', shareMode: 'subtree', blast: null, shareMsg: null,
};

const jval = (v: unknown): string => v == null ? '∅' : typeof v === 'string' ? v : JSON.stringify(v);

// ── data loaders ────────────────────────────────────────────────────────────

async function loadDrift(render: () => void): Promise<void> {
  S.driftLoading = true; S.driftError = ''; S.openDiff = null; render();
  try {
    const q = S.tenantId ? `?tenantId=${encodeURIComponent(S.tenantId)}` : '';
    const res = await api.get(`/admin/realm/${S.family}/drift${q}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    S.drift = ((await res.json()).entries ?? []) as DriftEntry[];
  } catch (e) { S.driftError = e instanceof Error ? e.message : String(e); S.drift = []; }
  finally { S.driftLoading = false; render(); }
}

async function openDiff(id: string, render: () => void): Promise<void> {
  S.diffLoading = true; S.openDiff = null; S.resolved = {}; S.mergeMsg = null; render();
  try {
    const res = await api.get(`/admin/realm/${S.family}/${encodeURIComponent(id)}/diff`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    S.openDiff = await res.json() as ThreeWayDiff;
  } catch (e) { S.mergeMsg = { ok: false, text: e instanceof Error ? e.message : String(e) }; }
  finally { S.diffLoading = false; render(); }
}

async function applyMerge(render: () => void): Promise<void> {
  if (!S.openDiff) return;
  const resolved: Record<string, unknown> = {};
  for (const f of S.openDiff.conflicts) resolved[f] = S.resolved[f] ?? '';
  const res = await api.post(`/admin/realm/${S.family}/${encodeURIComponent(S.openDiff.recordId)}/merge`, { resolved });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { S.mergeMsg = { ok: false, text: body.error || `HTTP ${res.status}` }; render(); return; }
  S.mergeMsg = { ok: true, text: `Merged — drift is now “${body.drift}”.` };
  S.openDiff = null;
  await loadDrift(render);
}

async function loadOverlay(render: () => void): Promise<void> {
  if (!S.tenantId) { S.overlayRows = null; S.overlayError = 'Enter a tenant id to manage its overlay.'; render(); return; }
  // NB: don't clear overlayMsg here — setOverlay/applyLean set it right before calling this to reload,
  // and nulling it would swallow the confirmation the operator just triggered.
  S.overlayLoading = true; S.overlayError = ''; render();
  try {
    // Effective rows for this tenant come from the family's own admin list; overlays come from realm-state.
    const listRes = await api.get(`/admin/${familyBase(S.family)}?tenantId=${encodeURIComponent(S.tenantId)}`);
    const listBody = await listRes.json().catch(() => ({}));
    S.overlayRows = (listBody[familyListKey(S.family)] ?? []) as Array<Record<string, unknown>>;
    const stRes = await api.get(`/admin/realm-state?family=${S.family}&tenantId=${encodeURIComponent(S.tenantId)}`);
    const states = ((await stRes.json().catch(() => ({}))).states ?? []) as Array<Record<string, unknown>>;
    S.overlayStates = {};
    for (const st of states) {
      S.overlayStates[String(st['logicalKey'])] = {
        enabled: st['enabled'] as boolean | null, priority: st['priority'] as number | null, pinnedVersion: st['pinnedVersion'] as number | null,
      };
    }
  } catch (e) { S.overlayError = e instanceof Error ? e.message : String(e); S.overlayRows = []; }
  finally { S.overlayLoading = false; render(); }
}

async function setOverlay(logicalKey: string, patch: Record<string, unknown>, render: () => void): Promise<void> {
  const res = await api.put('/admin/realm-state', { family: S.family, tenantId: S.tenantId, logicalKey, ...patch });
  const body = await res.json().catch(() => ({}));
  S.overlayMsg = res.ok ? { ok: true, text: `Overlay saved for “${logicalKey}”.` } : { ok: false, text: body.error || `HTTP ${res.status}` };
  await loadOverlay(render);
}

async function clearOverlay(logicalKey: string, render: () => void): Promise<void> {
  await api.del(`/admin/realm-state?family=${S.family}&tenantId=${encodeURIComponent(S.tenantId)}&logicalKey=${encodeURIComponent(logicalKey)}`);
  S.overlayMsg = { ok: true, text: `Overlay cleared for “${logicalKey}” — back to the shared default.` };
  await loadOverlay(render);
}

async function applyLean(on: boolean, render: () => void): Promise<void> {
  if (!S.tenantId) { S.overlayMsg = { ok: false, text: 'Enter a tenant id first.' }; render(); return; }
  const res = on
    ? await api.post(`/admin/realm/guardrails/profile/lean?tenantId=${encodeURIComponent(S.tenantId)}`)
    : await api.del(`/admin/realm/guardrails/profile/lean?tenantId=${encodeURIComponent(S.tenantId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { S.overlayMsg = { ok: false, text: body.error || `HTTP ${res.status}` }; render(); return; }
  S.overlayMsg = on
    ? { ok: true, text: `Lean posture applied — disabled ${(body.disabled ?? []).length} model-graded check(s); kept ${(body.protected ?? []).length} safety control(s) on.` }
    : { ok: true, text: 'Reverted to the shared guardrail posture.' };
  await loadOverlay(render);
}

async function loadBlast(render: () => void): Promise<void> {
  if (!S.sharePromptId) { S.blast = null; S.shareMsg = { ok: false, text: 'Enter a prompt fork id.' }; render(); return; }
  S.shareMsg = null;
  const res = await api.get(`/admin/prompts/${encodeURIComponent(S.sharePromptId)}/blast-radius?shareMode=${S.shareMode}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { S.blast = null; S.shareMsg = { ok: false, text: body.error || `HTTP ${res.status}` }; render(); return; }
  S.blast = body.blastRadius; render();
}

async function applyShare(render: () => void): Promise<void> {
  const res = await api.post(`/admin/prompts/${encodeURIComponent(S.sharePromptId)}/share`, { shareMode: S.shareMode });
  const body = await res.json().catch(() => ({}));
  S.shareMsg = res.ok ? { ok: true, text: `Share mode set to “${S.shareMode}”.` } : { ok: false, text: body.error || `HTTP ${res.status}` };
  render();
}

/** Admin list base + listKey per family (for the overlay's effective-rows lookup). */
function familyBase(family: string): string {
  const map: Record<string, string> = {
    prompts: 'prompts', prompt_fragments: 'prompt-fragments', skills: 'skills', worker_agents: 'worker-agents',
    guardrails: 'guardrails', tool_policies: 'tool-policies', routing_policies: 'routing', cost_policies: 'cost-policies',
    prompt_strategies: 'prompt-strategies', prompt_contracts: 'prompt-contracts', prompt_frameworks: 'prompt-frameworks',
  };
  return map[family] ?? family;
}
function familyListKey(family: string): string {
  const map: Record<string, string> = {
    prompts: 'prompts', prompt_fragments: 'fragments', skills: 'skills', worker_agents: 'workers',
    guardrails: 'guardrails', tool_policies: 'policies', routing_policies: 'policies', cost_policies: 'policies',
    prompt_strategies: 'strategies', prompt_contracts: 'contracts', prompt_frameworks: 'frameworks',
  };
  return map[family] ?? family;
}

// ── render ──────────────────────────────────────────────────────────────────

export function renderRealmView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  const root = h('div', { className: 'realm-wb' },
    h('div', { style: 'margin-bottom:14px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'Tenancy Realm'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'See what has drifted from the shipped defaults, three-way merge the tricky ones, tune a tenant’s posture, and preview how far a share reaches — all without leaving the console.'),
    ),
  );

  const nav = h('div', { className: 'rw-nav' });
  for (const [key, label] of [['drift', 'Drift & merge'], ['overlay', 'State overlay'], ['share', 'Share & reach']] as const) {
    nav.appendChild(h('button', {
      className: S.section === key ? 'active' : '', 'data-rw-section': key,
      onClick: () => { S.section = key; render(); },
    }, label));
  }
  root.appendChild(nav);

  if (S.section === 'drift') root.appendChild(renderDrift(render));
  else if (S.section === 'overlay') root.appendChild(renderOverlay(render));
  else root.appendChild(renderShare(render));
  return root;
}

function familyPicker(render: () => void): HTMLElement {
  const sel = h('select', {
    'data-rw-family': '',
    onChange: (e: Event) => { S.family = (e.target as HTMLSelectElement).value; S.drift = null; S.openDiff = null; S.overlayRows = null; render(); },
  }) as HTMLSelectElement;
  for (const f of FAMILIES) {
    const o = h('option', { value: f }, f) as HTMLOptionElement;
    if (f === S.family) o.selected = true;
    sel.appendChild(o);
  }
  return h('div', null, h('label', null, 'Family'), sel);
}

function tenantInput(render: () => void, onEnter: () => void): HTMLElement {
  return h('div', null,
    h('label', null, 'Tenant id'),
    h('input', {
      type: 'text', value: S.tenantId, placeholder: '(blank = all / global)', 'data-rw-tenant': '',
      onInput: (e: Event) => { S.tenantId = (e.target as HTMLInputElement).value.trim(); },
      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onEnter(); },
    }),
  );
}

function renderDrift(render: () => void): HTMLElement {
  const wrap = h('div', null);
  wrap.appendChild(h('p', { className: 'rw-hint' },
    'Every customized default is one of four states: in-sync, customized (your edit, upstream unchanged), stale (a new default shipped) or diverged (both changed — needs a merge). Pick a diverged row to reconcile it.'));

  const controls = h('div', { className: 'rw-controls' },
    familyPicker(render), tenantInput(render, () => void loadDrift(render)),
    h('button', { className: 'rw-btn', 'data-rw-load-drift': '', onClick: () => void loadDrift(render) }, 'Load drift'));
  wrap.appendChild(controls);

  if (S.driftLoading) { wrap.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;' }, 'Loading…')); return wrap; }
  if (S.driftError) { wrap.appendChild(h('div', { className: 'rw-msg err' }, S.driftError)); return wrap; }
  if (S.drift == null) return wrap;

  const summary: Record<string, number> = {};
  for (const e of S.drift) summary[e.state] = (summary[e.state] ?? 0) + 1;
  const summaryBar = h('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;', 'data-rw-summary': '' });
  // Known states first (in review-priority order), then anything else present (e.g. not_a_fork).
  const ordered = ['diverged', 'stale', 'customized', 'in_sync', ...Object.keys(summary)];
  const seen = new Set<string>();
  for (const st of ordered) {
    if (seen.has(st) || !summary[st]) continue;
    seen.add(st);
    summaryBar.appendChild(realmBadge(st, `${st.replace(/_/g, ' ')}: ${summary[st]}`));
  }
  if (!S.drift.length) summaryBar.appendChild(h('span', { style: 'font-size:12px;color:var(--fg2);' }, 'No records in this family.'));
  wrap.appendChild(summaryBar);

  const table = h('table', { 'data-rw-drift-table': '' },
    h('thead', null, h('tr', null, ...['Logical key', 'Realm', 'State', ''].map((c) => h('th', null, c)))));
  const tbody = h('tbody', null);
  for (const e of S.drift) {
    const clickable = e.state === 'diverged' || e.state === 'stale' || e.state === 'customized';
    const row = h('tr', {
      className: clickable ? 'rw-row-click' : '', 'data-rw-entry': e.id,
      onClick: clickable ? () => void openDiff(e.id, render) : undefined,
    },
      h('td', null, e.logicalKey),
      h('td', null, e.realm === 'tenant' ? realmBadge('own', e.ownerTenantId ?? 'tenant') : realmBadge('global', 'global')),
      h('td', null, realmBadge(e.state, e.state.replace('_', ' '))),
      h('td', { style: 'text-align:right;color:var(--fg2);font-size:11px;' }, clickable ? 'review →' : ''),
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (S.diffLoading) wrap.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;margin-top:10px;' }, 'Loading diff…'));
  if (S.openDiff) wrap.appendChild(renderDiffPanel(S.openDiff, render));
  if (S.mergeMsg) wrap.appendChild(h('div', { className: `rw-msg ${S.mergeMsg.ok ? 'ok' : 'err'}` }, S.mergeMsg.text));
  return wrap;
}

function renderDiffPanel(diff: ThreeWayDiff, render: () => void): HTMLElement {
  const panel = h('div', { className: 'rw-diff', 'data-rw-diff': diff.recordId },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;' },
      h('div', null,
        h('strong', { style: 'font-size:13px;' }, diff.logicalKey), ' ',
        realmBadge(diff.drift, diff.drift),
        diff.baseAvailable ? null : realmBadge('stale', 'no base — 2-way'),
      ),
      h('button', { className: 'rw-btn ghost', onClick: () => { S.openDiff = null; render(); } }, 'Close'),
    ),
  );
  if (!diff.baseAvailable) {
    panel.appendChild(h('p', { className: 'rw-hint' },
      'The version this was forked from was never published, so there is no base to compare against. Every differing field is shown as a conflict — resolve each one deliberately.'));
  }

  panel.appendChild(h('div', { className: 'rw-field', style: 'font-weight:600;color:var(--fg2);' },
    h('div', null, 'Field'), h('div', null, 'Base'), h('div', null, 'Yours (local)'), h('div', null, 'Upstream (remote)')));

  // The merge button reflects the LIVE conflict-resolution state. It is rebuilt each render, but typing
  // in a conflict textarea must not force a re-render (that would drop focus mid-word), so each textarea
  // updates the button imperatively via this closure instead.
  const mergeBtn = h('button', { className: 'rw-btn', 'data-rw-merge': '', onClick: () => void applyMerge(render) }) as HTMLButtonElement;
  const refreshMergeBtn = (): void => {
    const unresolved = diff.conflicts.filter((c) => !(S.resolved[c] && S.resolved[c].length));
    mergeBtn.disabled = unresolved.length > 0;
    mergeBtn.textContent = unresolved.length ? `Resolve ${unresolved.length} conflict(s) to merge` : 'Apply merge';
  };

  for (const f of diff.fields) {
    if (f.status === 'unchanged') continue;
    const fieldRow = h('div', { className: `rw-field ${f.status === 'conflict' ? 'conflict' : ''}`, 'data-rw-field': f.field },
      h('div', null, h('strong', null, f.field), h('div', { style: 'margin-top:3px;' }, realmBadge(statusBadge(f.status), f.status.replace('_', ' ')))),
      h('div', { className: 'rw-val' }, jval(f.base)),
      h('div', { className: 'rw-val' }, jval(f.local)),
      h('div', { className: 'rw-val' }, jval(f.remote)),
    );
    if (f.status === 'conflict') {
      fieldRow.appendChild(h('div', { style: 'grid-column:1 / -1;margin-top:4px;' },
        h('label', { style: 'font-size:11px;color:var(--danger);' }, 'Resolve — the value to keep:'),
        h('textarea', {
          'data-rw-resolve': f.field, placeholder: 'Enter the merged value for this field',
          onInput: (e: Event) => { S.resolved[f.field] = (e.target as HTMLTextAreaElement).value; refreshMergeBtn(); },
        }, S.resolved[f.field] ?? ''),
      ));
    }
    panel.appendChild(fieldRow);
  }

  refreshMergeBtn();
  panel.appendChild(h('div', { style: 'margin-top:12px;display:flex;gap:8px;align-items:center;' }, mergeBtn,
    h('span', { style: 'font-size:11px;color:var(--fg2);' }, 'Non-conflicting fields auto-merge; applying re-baselines so this never reads “diverged” again.')));
  return panel;
}

const statusBadge = (status: string): string =>
  status === 'conflict' ? 'diverged' : status === 'remote_only' ? 'stale' : status === 'local_only' ? 'own' : status === 'both_same' ? 'in_sync' : 'global';

function renderOverlay(render: () => void): HTMLElement {
  const wrap = h('div', null);
  wrap.appendChild(h('p', { className: 'rw-hint' },
    'Turn a shared built-in off for one tenant, bump its priority, or pin it to a version — without forking it. An overlay can only ever subtract: it never switches on something the platform disabled globally.'));

  const controls = h('div', { className: 'rw-controls' },
    familyPicker(render), tenantInput(render, () => void loadOverlay(render)),
    h('button', { className: 'rw-btn', 'data-rw-load-overlay': '', onClick: () => void loadOverlay(render) }, 'Load'));
  if (S.family === 'guardrails') {
    controls.appendChild(h('button', { className: 'rw-btn ghost', 'data-rw-lean-on': '', onClick: () => void applyLean(true, render) }, 'Apply lean posture'));
    controls.appendChild(h('button', { className: 'rw-btn ghost', 'data-rw-lean-off': '', onClick: () => void applyLean(false, render) }, 'Revert posture'));
  }
  wrap.appendChild(controls);

  if (S.overlayMsg) wrap.appendChild(h('div', { className: `rw-msg ${S.overlayMsg.ok ? 'ok' : 'err'}` }, S.overlayMsg.text));
  if (S.overlayLoading) { wrap.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;' }, 'Loading…')); return wrap; }
  if (S.overlayError) { wrap.appendChild(h('div', { className: 'rw-msg err' }, S.overlayError)); return wrap; }
  if (S.overlayRows == null) return wrap;

  const table = h('table', { 'data-rw-overlay-table': '' },
    h('thead', null, h('tr', null, ...['Logical key', 'Enabled for tenant', 'Priority', 'Pinned', ''].map((c) => h('th', null, c)))));
  const tbody = h('tbody', null);
  for (const row of S.overlayRows) {
    const key = String(row['logical_key'] ?? row['key'] ?? row['name'] ?? row['id']);
    const ov = S.overlayStates[key];
    const enabledOff = ov?.enabled === false;
    tbody.appendChild(h('tr', { 'data-rw-overlay-row': key },
      h('td', null, key, ov ? h('span', { style: 'margin-left:6px;' }, realmBadge('own', 'overlay')) : null),
      h('td', null, h('button', {
        className: 'rw-btn ghost', 'data-rw-toggle': key,
        onClick: () => void setOverlay(key, { enabled: enabledOff ? null : false }, render),
      }, enabledOff ? 'Disabled — re-enable' : 'On — disable for tenant')),
      h('td', null, h('input', {
        type: 'number', style: 'width:70px;', value: ov?.priority ?? '', placeholder: '—',
        'data-rw-priority': key,
        onChange: (e: Event) => { const v = (e.target as HTMLInputElement).value; void setOverlay(key, { priority: v === '' ? null : Number(v) }, render); },
      })),
      h('td', null, h('input', {
        type: 'number', style: 'width:70px;', value: ov?.pinnedVersion ?? '', placeholder: '—',
        'data-rw-pin': key,
        onChange: (e: Event) => { const v = (e.target as HTMLInputElement).value; void setOverlay(key, { pinnedVersion: v === '' ? null : Number(v) }, render); },
      })),
      h('td', { style: 'text-align:right;' }, ov ? h('button', { className: 'rw-btn ghost', 'data-rw-clear': key, onClick: () => void clearOverlay(key, render) }, 'Clear') : null),
    ));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderShare(render: () => void): HTMLElement {
  const wrap = h('div', null);
  wrap.appendChild(h('p', { className: 'rw-hint' },
    'A tenant’s prompt fork can be shared down its part of the org tree. Preview the blast radius first: who would start inheriting it, who keeps their own copy, and who is out of scope.'));

  const modeSel = h('select', {
    'data-rw-sharemode': '',
    onChange: (e: Event) => { S.shareMode = (e.target as HTMLSelectElement).value; S.blast = null; render(); },
  }) as HTMLSelectElement;
  for (const m of ['private', 'children', 'subtree']) {
    const o = h('option', { value: m }, m) as HTMLOptionElement;
    if (m === S.shareMode) o.selected = true;
    modeSel.appendChild(o);
  }

  wrap.appendChild(h('div', { className: 'rw-controls' },
    h('div', null, h('label', null, 'Prompt fork id'),
      h('input', { type: 'text', value: S.sharePromptId, placeholder: 'a tenant prompt fork id', 'data-rw-shareid': '', style: 'width:300px;',
        onInput: (e: Event) => { S.sharePromptId = (e.target as HTMLInputElement).value.trim(); } })),
    h('div', null, h('label', null, 'Share mode'), modeSel),
    h('button', { className: 'rw-btn ghost', 'data-rw-blast': '', onClick: () => void loadBlast(render) }, 'Preview reach'),
    h('button', { className: 'rw-btn', 'data-rw-share': '', onClick: () => void applyShare(render) }, 'Apply share mode'),
  ));

  if (S.shareMsg) wrap.appendChild(h('div', { className: `rw-msg ${S.shareMsg.ok ? 'ok' : 'err'}` }, S.shareMsg.text));
  if (S.blast) {
    wrap.appendChild(h('div', { className: 'rw-diff', 'data-rw-blast-result': '' },
      h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;' },
        h('div', null, h('div', { style: 'font-size:11px;color:var(--fg2);text-transform:uppercase;' }, 'Inheriting'),
          h('div', { style: 'font-size:20px;font-weight:700;color:var(--amber);' }, String(S.blast.inheriting.length)),
          h('div', { style: 'font-size:11px;color:var(--fg2);' }, S.blast.inheriting.join(', ') || '—')),
        h('div', null, h('div', { style: 'font-size:11px;color:var(--fg2);text-transform:uppercase;' }, 'Shadowed (own copy)'),
          h('div', { style: 'font-size:20px;font-weight:700;color:var(--accent);' }, String(S.blast.shadowed.length)),
          h('div', { style: 'font-size:11px;color:var(--fg2);' }, S.blast.shadowed.join(', ') || '—')),
        h('div', null, h('div', { style: 'font-size:11px;color:var(--fg2);text-transform:uppercase;' }, 'Out of scope'),
          h('div', { style: 'font-size:20px;font-weight:700;color:var(--fg2);' }, String(S.blast.outOfScope))),
      )));
  }
  return wrap;
}
