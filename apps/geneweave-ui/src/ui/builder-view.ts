// SPDX-License-Identifier: MIT
/**
 * geneWeave BUILDER — the full-bleed three-pane "configure the assistant" app, recreated
 * from "GeneWeave Builder.dc.html" and generalised into a SKIN over the entire admin layer.
 *
 * The left nav mirrors the admin's groups/tabs (ASSISTANT SETUP + every other section), the
 * collection lists the selected resource's records, and the editor renders that resource's
 * schema fields in the Builder's bespoke style. Navigation stays INSIDE the Builder — clicking
 * a tab loads + edits it here, never bouncing to the old admin. It reuses the admin data +
 * schema + save/delete machinery (loadAdmin, ADMIN_SCHEMA/ADMIN_GROUPS, adminEditRow/
 * adminNewRow/adminSaveRow/adminDeleteRow), so EVERY admin resource is available and works.
 *
 * Modular: the generic field renderer lives in builder-editor.ts; this file owns the shell,
 * the nav + collection, and the wiring to the admin layer.
 */
import { h } from './dom.js';
import { loadingPlaceholder } from './skeleton.js';
import { state } from './state.js';
import { wovenMarkSvg, wordmarkHtml } from './notes-brand.js';
import { getAdminSchema, adminSaveRow, adminDeleteRow, clearAdminEditorState } from './admin-ui.js';
import { renderBuilderFields, renderBuilderActionBar, jsonFieldsInvalid, type FieldSchema } from './builder-editor.js';

export interface BuilderOptions { loadAdmin: () => Promise<void> }

interface NavGroup { key?: string; label: string; tabs: Array<{ key: string; label: string }> }
type Row = Record<string, unknown>;

// ── module-local state ───────────────────────────────────────────────────────
let _loaded = false;
let _loading = false;
let _pristineForm: string | null = null;
let _toast = false;
let _toastTimer: ReturnType<typeof setTimeout> | null = null;
let _lastTab: string | null = null;

function adminGroups(): NavGroup[] {
  const schema = ((typeof window !== 'undefined' && (window as { ADMIN_SCHEMA?: Record<string, unknown> }).ADMIN_SCHEMA) || {});
  const groups = ((typeof window !== 'undefined' && (window as { ADMIN_GROUPS?: NavGroup[] }).ADMIN_GROUPS) || []) as NavGroup[];
  return groups
    .map((g) => ({ ...g, tabs: (g.tabs || []).filter((t) => t.key in schema) }))
    .filter((g) => g.tabs.length);
}
function allTabs(): string[] { return Object.keys(((typeof window !== 'undefined' && (window as { ADMIN_SCHEMA?: Record<string, unknown> }).ADMIN_SCHEMA) || {})); }
function rowsFor(tab: string): Row[] { return ((state.adminData as Record<string, Row[]> | undefined)?.[tab]) || []; }
function rowId(row: Row, schema: { cols?: string[] }): string { return String(row['id'] ?? row[(schema.cols?.[0]) ?? 'id'] ?? ''); }
function rowName(row: Row): string { return String(row['name'] ?? row['label'] ?? row['title'] ?? row['key'] ?? row['id'] ?? 'Untitled'); }
function rowKey(row: Row): string { return String(row['key'] ?? row['slug'] ?? row['provider'] ?? ''); }
function rowEnabled(row: Row): boolean | null { return ('enabled' in row) ? (row['enabled'] !== 0 && row['enabled'] !== false) : (('active' in row) ? (row['active'] !== 0 && row['active'] !== false) : null); }
function isDirty(): boolean { return _pristineForm != null && JSON.stringify(state.adminForm ?? {}) !== _pristineForm; }
function snapshot(): void { _pristineForm = JSON.stringify(state.adminForm ?? {}); }

async function ensureLoaded(opts: BuilderOptions, render: () => void): Promise<void> {
  if (_loaded || _loading) return;
  _loading = true;
  try { await opts.loadAdmin(); } catch { /* */ }
  _loaded = true; _loading = false;
  // pick a default tab + open its first record
  if (!state.adminTab || !(allTabs().includes(state.adminTab as string))) state.adminTab = allTabs().includes('prompt-fragments') ? 'prompt-fragments' : allTabs()[0] ?? '';
  openFirst(render);
  render();
}
function openFirst(render: () => void): void {
  const tab = state.adminTab as string;
  const rows = rowsFor(tab);
  clearAdminEditorState();
  _pristineForm = null;
  if (rows[0]) openRow(rows[0], render);
}
// Populate the edit form from a row, generically (mirrors the admin's field transforms:
// CSV arrays → comma string, JSON/textarea objects → pretty JSON) so every resource — even
// prompts — edits inline in the Builder without the legacy multi-step wizard.
function openRow(row: Row, render: () => void): void {
  const tab = state.adminTab as string;
  const schema = getAdminSchema(tab);
  if (!schema) return;
  state.adminEditing = (row['id'] ?? row[(schema.cols?.[0]) ?? 'id'] ?? null) as string | null;
  const form: Row = { ...row };
  (schema.fields ?? []).forEach((field: { key: string; save?: string; textarea?: boolean }) => {
    const v = form[field.key];
    if (field.save === 'csvArr' && v != null) {
      try { const arr = typeof v === 'string' ? JSON.parse(v) : v; if (Array.isArray(arr)) form[field.key] = arr.join(', '); } catch { /* leave */ }
    } else if ((field.textarea || field.save === 'json' || field.save === 'jsonStr') && v != null && typeof v !== 'string') {
      try { form[field.key] = JSON.stringify(v, null, 2); } catch { /* leave */ }
    }
  });
  state.adminForm = form;
  snapshot();
  void render;
}
function selectTab(tab: string, render: () => void): void {
  if (state.adminTab === tab) return;
  state.adminTab = tab; _toast = false;
  openFirst(render);
  render();
}
function newRecord(render: () => void): void {
  const schema = getAdminSchema(state.adminTab as string);
  const form: Row = {};
  (schema?.fields ?? []).forEach((field: { key: string; default?: unknown; save?: string }) => {
    if (field.default !== undefined) form[field.key] = field.default;
    else if (field.save === 'csvArr') form[field.key] = '';
    else if (field.save === 'json' || field.save === 'jsonStr') form[field.key] = '[]';
  });
  state.adminEditing = null;
  state.adminForm = form;
  snapshot();
  render();
}
function cancel(render: () => void): void {
  const tab = state.adminTab as string;
  if (state.adminEditing) {
    const schema = getAdminSchema(tab);
    const row = rowsFor(tab).find((r) => rowId(r, schema) === String(state.adminEditing));
    if (row) { openRow(row, render); render(); return; }
  }
  clearAdminEditorState(); _pristineForm = null; openFirst(render); render();
}
async function save(opts: BuilderOptions, render: () => void): Promise<void> {
  const tab = state.adminTab as string;
  const schema = getAdminSchema(tab);
  if (jsonFieldsInvalid((schema?.fields ?? []) as FieldSchema[], (k) => (state.adminForm as Row)?.[k])) return;
  const prevId = state.adminEditing ? String(state.adminEditing) : null;
  const prevKey = String((state.adminForm as Row)?.['key'] ?? (state.adminForm as Row)?.['name'] ?? '');
  await adminSaveRow(tab, render, opts.loadAdmin); // clears editing + reloads
  // reselect the saved record so the editor stays open
  const rows = rowsFor(tab);
  const match = (prevId && rows.find((r) => rowId(r, schema) === prevId)) || rows.find((r) => String(r['key'] ?? r['name'] ?? '') === prevKey) || rows[0];
  if (match) openRow(match, render);
  _toast = true;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toast = false; render(); }, 2200);
  render();
}
async function remove(opts: BuilderOptions, render: () => void): Promise<void> {
  const tab = state.adminTab as string;
  if (!state.adminEditing) { cancel(render); return; }
  await adminDeleteRow(tab, { id: state.adminEditing }, render, opts.loadAdmin);
  clearAdminEditorState(); _pristineForm = null; openFirst(render); render();
}

// ── left nav (mirrors the admin groups/tabs) ─────────────────────────────────
function renderNav(render: () => void): HTMLElement {
  const userName = (state.user as { name?: string } | undefined)?.name ?? 'Admin';
  const groups = adminGroups();
  const grouped = new Set(groups.flatMap((g) => g.tabs.map((t) => t.key)));
  const orphans = allTabs().filter((t) => !grouped.has(t)).map((t) => ({ key: t, label: t.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) }));
  const expanded = (state.adminGroupExpanded ?? (state.adminGroupExpanded = {})) as Record<string, boolean>;

  function group(label: string, key: string, tabs: Array<{ key: string; label: string }>, openByDefault: boolean): HTMLElement {
    const isOpen = expanded[key] ?? openByDefault;
    return h('div', { className: 'bld-nav-group' },
      h('button', { className: 'bld-nav-grouphead', onClick: () => { expanded[key] = !isOpen; render(); } },
        h('span', { className: 'bld-nav-label' }, label.toUpperCase()),
        h('span', { className: `bld-nav-caret${isOpen ? ' open' : ''}` }, '▾')),
      isOpen ? h('div', { className: 'bld-nav-list' },
        ...tabs.map((t) => h('div', { className: `bld-nav-item${state.adminTab === t.key ? ' active' : ''}`, onClick: () => selectTab(t.key, render) },
          h('span', { className: 'bld-nav-dot' }), h('span', { className: 'bld-nav-itemlabel' }, t.label))),
      ) : null,
    );
  }

  return h('nav', { className: 'bld-nav' },
    h('button', { className: 'bld-brand', title: 'Back to geneWeave', onClick: () => { state.view = 'chat'; render(); } },
      h('span', { innerHTML: wovenMarkSvg(26, 'duo') }), h('span', { className: 'bld-brand-word', innerHTML: wordmarkHtml() })),
    h('div', { className: 'bld-nav-body gw-scroll', 'data-scroll-key': 'builder-nav' },
      ...groups.map((g, i) => group(g.label, g.key ?? g.label, g.tabs, i === 0)),
      orphans.length ? group('More', '__more', orphans, false) : null,
    ),
    h('div', { className: 'bld-nav-foot' },
      h('div', { className: 'bld-nav-item plain', onClick: () => { state.view = 'chat'; render(); } },
        h('span', { className: 'bld-nav-arrow', innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' }), h('span', null, 'Switch to Daily')),
      h('div', { className: 'bld-nav-account' }, h('span', { className: 'bld-account-avatar' }, (userName[0] ?? 'G').toUpperCase()), h('span', null, `${userName} · Admin`)),
    ),
  );
}

// ── collection pane ──────────────────────────────────────────────────────────
function renderCollection(render: () => void): HTMLElement {
  const tab = state.adminTab as string;
  const schema = getAdminSchema(tab) ?? {};
  const rows = rowsFor(tab);
  const title = schema.plural ?? (schema.singular ? `${schema.singular}s` : (tab.replace(/[-_]/g, ' ').replace(/\b\w/g, (m: string) => m.toUpperCase())));
  return h('section', { className: 'bld-collection' },
    h('header', { className: 'bld-coll-head' },
      h('div', { className: 'bld-coll-titlebar' },
        h('div', { className: 'bld-coll-title-wrap' }, h('h1', { className: 'bld-coll-title' }, title), h('span', { className: 'bld-coll-count' }, String(rows.length))),
        schema.readOnly ? null : h('button', { className: 'bld-new-btn', onClick: () => newRecord(render) }, h('span', { className: 'bld-new-plus' }, '+'), ' New'),
      ),
      h('div', { className: 'bld-coll-search-row' },
        h('div', { className: 'bld-coll-search' },
          h('span', { className: 'bld-coll-search-ic', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>' }),
          h('span', { className: 'bld-coll-search-ph' }, `Search ${title.toLowerCase()}`)),
        h('button', { className: 'bld-coll-filter', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg>' }),
      ),
      h('div', { className: 'bld-coll-cols' }, h('span', { className: 'bld-col-name' }, 'NAME'), h('span', { className: 'bld-col-status' }, 'STATUS')),
    ),
    h('div', { className: 'bld-coll-list gw-scroll', 'data-scroll-key': 'builder-list' },
      _loading ? loadingPlaceholder('list', 'Loading…') : null,
      ...rows.map((row) => {
        const id = rowId(row, schema);
        const on = rowEnabled(row);
        const active = id === String(state.adminEditing);
        return h('div', { className: `bld-row${active ? ' active' : ''}`, onClick: () => { openRow(row, render); render(); } },
          on === null ? h('span', { className: 'bld-row-dot neutral' }) : h('span', { className: `bld-row-dot${on ? ' on' : ''}` }),
          h('div', { className: 'bld-row-body' }, h('div', { className: 'bld-row-name' }, rowName(row)), rowKey(row) ? h('div', { className: 'bld-row-key' }, rowKey(row)) : null),
          on === null ? null : h('span', { className: `bld-pill${on ? ' on' : ' off'}` }, on ? 'On' : 'Off'),
        );
      }),
      (!_loading && rows.length === 0) ? h('div', { className: 'bld-coll-empty' }, 'No records yet.') : null,
    ),
    h('footer', { className: 'bld-coll-foot' },
      h('span', { className: 'bld-coll-range' }, rows.length ? `1–${rows.length} of ${rows.length}` : '0 of 0'),
      h('div', { className: 'bld-coll-pager' }, h('button', { className: 'bld-pager-btn', disabled: true }, '‹'), h('button', { className: 'bld-pager-btn', disabled: true }, '›')),
    ),
  );
}

// ── editor pane ──────────────────────────────────────────────────────────────
function renderEditorPane(opts: BuilderOptions, render: () => void): HTMLElement {
  const tab = state.adminTab as string;
  const schema = getAdminSchema(tab) ?? {};
  const form = (state.adminForm ?? {}) as Row;
  const hasForm = Object.keys(form).length > 0 || state.adminEditing != null;

  if (!hasForm) {
    return h('section', { className: 'bld-editor' }, h('div', { className: 'bld-editor-empty' }, 'Select a record, or press + New.'));
  }
  const dirty = isDirty();
  const jsonInvalid = jsonFieldsInvalid((schema.fields ?? []) as FieldSchema[], (k) => form[k]);
  const name = String(form['name'] ?? form['label'] ?? form['title'] ?? form['key'] ?? schema.singular ?? 'Record');
  const eyebrow = `${(schema.groupLabel ?? 'ASSISTANT SETUP')} / ${(schema.plural ?? (schema.singular ? schema.singular + 's' : tab)).toUpperCase()}`;

  const body = h('div', { className: 'bld-editor-scroll gw-scroll', 'data-scroll-key': 'builder-editor' },
    renderBuilderFields(schema, { get: (k) => (state.adminForm as Row)?.[k], set: (k, v) => { state.adminForm = { ...(state.adminForm as Row), [k]: v }; render(); } }),
    schema.readOnly ? null : h('div', { className: 'bld-form bld-danger-wrap' },
      h('div', { className: 'bld-danger' },
        h('div', { className: 'bld-danger-text' }, h('span', { className: 'bld-danger-title' }, `Delete ${schema.singular ?? 'record'}`), h('span', { className: 'bld-danger-sub' }, 'This can’t be undone.')),
        h('button', { className: 'bld-danger-btn', onClick: () => void remove(opts, render) }, 'Delete'),
      ),
    ),
  );

  return h('section', { className: 'bld-editor' },
    h('header', { className: 'bld-editor-head' },
      h('div', { className: 'bld-editor-titles' }, h('div', { className: 'bld-editor-eyebrow' }, eyebrow), h('h2', { className: 'bld-editor-name' }, name)),
      h('button', { className: 'bld-editor-more' }, '⋯'),
    ),
    body,
    schema.readOnly ? null : renderBuilderActionBar(dirty, jsonInvalid, () => void save(opts, render), () => cancel(render)),
  );
}

/** The Builder app (full-bleed three-pane over the whole admin). */
export function renderBuilderView(render: () => void, opts: BuilderOptions): HTMLElement {
  void ensureLoaded(opts, render);
  // If the tab changed externally (e.g. via a deep-link), open its first record.
  if (_loaded && state.adminTab !== _lastTab) { _lastTab = state.adminTab as string; if (state.adminEditing == null) openFirst(render); }
  return h('div', { className: 'bld-app' },
    renderNav(render),
    renderCollection(render),
    renderEditorPane(opts, render),
    _toast ? h('div', { className: 'bld-toast' }, h('span', { className: 'bld-toast-check', innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2FD39B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' }), 'Saved') : null,
  );
}
