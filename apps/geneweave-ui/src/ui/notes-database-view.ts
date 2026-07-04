// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 6 — note DATABASES UI (Notion-style tables).
 *
 * --- For someone new to this ---
 * A "database" here is a table of notes/rows with typed COLUMNS (text, number, a
 * dropdown, a date, a checkbox, a link to another table…). You can look at the same
 * rows as a TABLE, a GALLERY of cards, or a BOARD grouped by a dropdown column. And
 * each text-ish column has an "✨ Fill" button: the AI fills that column for every row
 * from what it already knows (plus, optionally, a web search) — and shows a little
 * citation so you can check where each value came from.
 */
import { h } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { promptDialog } from './dialog.js';

interface PropertyDef { key: string; name: string; type: string; options?: string[] }
interface ViewRow { id: string; fields: Record<string, unknown>; rollups: Record<string, unknown>; citations: Record<string, Array<{ label: string; url?: string }>> }
interface DatabaseView { id: string; name: string; viewType: string; schema: PropertyDef[]; rows: ViewRow[] }

/** Render the cell value for display. */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? '✓' : '';
  return String(value);
}

/** The main databases view: a list of databases, or one open database rendered by its view type. */
export function renderDatabasesView(render: () => void): HTMLElement {
  const container = h('div', { className: 'notes-db-view' }) as HTMLElement;

  if (!state.currentDatabaseId) { void renderList(container, render); return container; }
  void renderDatabase(container, state.currentDatabaseId, render);
  return container;
}

async function renderList(container: HTMLElement, render: () => void): Promise<void> {
  container.innerHTML = '';
  container.appendChild(h('div', { className: 'notes-db-header' },
    h('button', { className: 'notes-back-btn', onClick: () => { state.notesView = 'list'; render(); } }, '← Notes'),
    h('span', { className: 'notes-db-title' }, '🗃 Databases'),
    h('button', { className: 'notes-db-new-btn', onClick: () => void createDatabase(render) }, '+ New database'),
  ));
  try {
    const data = await (await api.get('/api/me/note-databases')).json() as { databases: Array<{ id: string; name: string; view_type: string }> };
    if (!data.databases.length) { container.appendChild(h('div', { className: 'notes-db-empty' }, 'No databases yet. Create one to get started.')); return; }
    const listEl = h('div', { className: 'notes-db-list' });
    for (const d of data.databases) {
      listEl.appendChild(h('button', { className: 'notes-db-card', onClick: () => { state.currentDatabaseId = d.id; render(); } },
        h('div', { className: 'notes-db-card-name' }, d.name), h('div', { className: 'notes-db-card-type' }, d.view_type)));
    }
    container.appendChild(listEl);
  } catch { container.appendChild(h('div', { className: 'notes-db-empty' }, 'Could not load databases.')); }
}

async function createDatabase(render: () => void): Promise<void> {
  const name = await promptDialog({ title: 'New database', message: 'Name your database.', placeholder: 'e.g. Projects', required: true, confirmLabel: 'Create' }); if (!name) return;
  // Seed a simple schema: a Name (text) and a Summary (text, AI-fillable) column.
  const columns = [{ key: 'name', name: 'Name', type: 'text' }, { key: 'summary', name: 'Summary', type: 'text' }];
  const res = await api.post('/api/me/note-databases', { name, view_type: 'table', columns });
  if (res.ok) { const d = await res.json() as { id: string }; state.currentDatabaseId = d.id; render(); }
}

async function renderDatabase(container: HTMLElement, dbId: string, render: () => void): Promise<void> {
  container.innerHTML = '';
  container.appendChild(h('div', { className: 'notes-db-loading' }, 'Loading database…'));
  let view: DatabaseView | null = null;
  try { const res = await api.get(`/api/me/note-databases/${dbId}/view`); if (res.ok) view = await res.json() as DatabaseView; } catch { /* */ }
  container.innerHTML = '';
  if (!view) { container.appendChild(h('div', { className: 'notes-db-empty' }, 'Database not found.')); return; }
  const v = view;

  const fillColumn = async (propertyKey: string, useWeb: boolean): Promise<void> => {
    container.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
    try { await api.post(`/api/me/note-databases/${dbId}/autofill`, { propertyKey, useWeb }); } catch { /* */ }
    await renderDatabase(container, dbId, render); // reload with filled values
  };
  const addRow = async (): Promise<void> => {
    const name = await promptDialog({ title: 'Add a row', message: 'Give the new row a name.', placeholder: 'Row name', confirmLabel: 'Add' }); if (name == null) return;
    await api.post(`/api/me/note-databases/${dbId}/rows`, { fields: { name } });
    await renderDatabase(container, dbId, render);
  };

  // Header: back, title, view-type switcher, add row.
  const switcher = h('div', { className: 'notes-db-viewswitch' },
    ...['table', 'gallery', 'board'].map((vt) => h('button', {
      className: `notes-db-vt${v.viewType === vt ? ' active' : ''}`,
      onClick: async () => { await api.post(`/api/me/note-databases/${dbId}`, {}).catch(() => undefined); v.viewType = vt; renderBody(); },
    }, vt)));
  container.appendChild(h('div', { className: 'notes-db-header' },
    h('button', { className: 'notes-back-btn', onClick: () => { state.currentDatabaseId = null; render(); } }, '← Databases'),
    h('span', { className: 'notes-db-title' }, v.name),
    switcher,
    h('button', { className: 'notes-db-addrow-btn', onClick: () => void addRow() }, '+ Row'),
  ));
  const bodyEl = h('div', { className: 'notes-db-body' }) as HTMLElement;
  container.appendChild(bodyEl);

  function fillBtns(p: PropertyDef): HTMLElement | null {
    if (p.type === 'rollup' || p.type === 'relation') return null;
    return h('span', { className: 'notes-db-fill' },
      h('button', { className: 'notes-db-fill-btn', title: `AI-fill the ${p.name} column`, onClick: () => void fillColumn(p.key, false) }, '✨'),
      h('button', { className: 'notes-db-fill-web', title: `AI-fill ${p.name} using a web search`, onClick: () => void fillColumn(p.key, true) }, '🌐'),
    );
  }
  function cellEl(row: ViewRow, p: PropertyDef): HTMLElement {
    const val = p.type === 'rollup' ? row.rollups[p.key] : row.fields[p.key];
    const cites = row.citations[p.key];
    const cell = h('div', { className: 'notes-db-cell' }, h('span', {}, cellText(val)));
    if (cites?.length) {
      const c = cites[0]!;
      cell.appendChild(c.url
        ? h('a', { className: 'notes-db-cite', href: c.url, target: '_blank', rel: 'noreferrer', title: c.label }, '🔖')
        : h('span', { className: 'notes-db-cite', title: c.label }, '🔖'));
    }
    return cell;
  }

  function renderBody(): void {
    bodyEl.innerHTML = '';
    if (v.viewType === 'gallery') {
      const grid = h('div', { className: 'notes-db-gallery' });
      for (const row of v.rows) {
        const card = h('div', { className: 'notes-db-gallery-card' });
        for (const p of v.schema) card.appendChild(h('div', { className: 'notes-db-gallery-field' }, h('span', { className: 'notes-db-k' }, p.name + ': '), cellEl(row, p)));
        grid.appendChild(card);
      }
      bodyEl.appendChild(grid);
      return;
    }
    if (v.viewType === 'board') {
      const groupProp = v.schema.find((p) => p.type === 'select') ?? v.schema[0]!;
      const groups = new Map<string, ViewRow[]>();
      for (const row of v.rows) { const g = String(row.fields[groupProp.key] ?? '—'); (groups.get(g) ?? groups.set(g, []).get(g)!).push(row); }
      const cols = h('div', { className: 'notes-db-board' });
      for (const [g, rows] of groups) {
        const col = h('div', { className: 'notes-db-board-col' }, h('div', { className: 'notes-db-board-title' }, `${groupProp.name}: ${g} (${rows.length})`));
        for (const row of rows) col.appendChild(h('div', { className: 'notes-db-board-card' }, cellText(row.fields[v.schema[0]!.key])));
        cols.appendChild(col);
      }
      bodyEl.appendChild(cols);
      return;
    }
    // table (default)
    const table = h('table', { className: 'notes-db-table' });
    const head = h('tr', { className: 'notes-db-row notes-db-head' });
    for (const p of v.schema) head.appendChild(h('th', { className: 'notes-db-th' }, h('span', {}, p.name + ' '), h('span', { className: 'notes-db-type' }, `(${p.type})`), fillBtns(p) as HTMLElement));
    table.appendChild(head);
    for (const row of v.rows) {
      const tr = h('tr', { className: 'notes-db-row' });
      for (const p of v.schema) { const td = h('td', { className: 'notes-db-td' }); td.appendChild(cellEl(row, p)); tr.appendChild(td); }
      table.appendChild(tr);
    }
    bodyEl.appendChild(table);
  }
  renderBody();
}
