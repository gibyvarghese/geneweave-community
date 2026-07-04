/**
 * GeneWeave — Capability Matrix UI (anyWeave Phase 4 / M16)
 *
 * Renders a heatmap of model × task_key capability scores. Operators can
 * filter by tenant; cells are colour-coded (red <60, amber 60–80, green ≥80).
 * Rendered when admin tab schema has customView = 'capability-matrix'.
 */

import { h } from './dom.js';
import { api } from './api.js';

interface ModelRow {
  provider: string;
  model_id: string;
  tenant_id: string | null;
  scores: Record<string, number>;
}

interface MatrixState {
  loading: boolean;
  error: string | null;
  tenantFilter: string;
  taskKeys: string[];
  models: ModelRow[];
  total: number;
  loaded: boolean;
}

const matrixState: MatrixState = {
  loading: false,
  error: null,
  tenantFilter: '',
  taskKeys: [],
  models: [],
  total: 0,
  loaded: false,
};

async function loadHeatmap(render: () => void): Promise<void> {
  matrixState.loading = true;
  matrixState.error = null;
  render();
  try {
    const qs = matrixState.tenantFilter ? `?tenantId=${encodeURIComponent(matrixState.tenantFilter)}` : '';
    const resp = await api.get(`/admin/capability-scores/heatmap${qs}`);
    if (!resp.ok) {
      matrixState.error = `Load failed: HTTP ${resp.status}`;
    } else {
      const data = await resp.json();
      matrixState.taskKeys = Array.isArray(data.taskKeys) ? data.taskKeys : [];
      matrixState.models = Array.isArray(data.models) ? data.models : [];
      matrixState.total = Number(data.total ?? matrixState.models.length);
      matrixState.loaded = true;
    }
  } catch (err) {
    matrixState.error = err instanceof Error ? err.message : String(err);
  } finally {
    matrixState.loading = false;
    render();
  }
}

function cellColor(score: number | undefined): string {
  if (score == null) return 'background:var(--bg2,#f5f5f5);color:var(--fg2,#888);';
  if (score < 60) return 'background:#fdecea;color:#b71c1c;';
  if (score < 80) return 'background:#fff8e1;color:#8a6d3b;';
  return 'background:#e8f5e9;color:#1b5e20;';
}

export function renderCapabilityMatrixView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  if (!matrixState.loaded && !matrixState.loading) {
    void loadHeatmap(render);
  }

  const container = h('div', { className: 'capmatrix-container', style: 'max-width:1400px;' },
    h('div', { style: 'margin-bottom:14px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'Capability Matrix'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Heatmap of model capability scores by task type. Cells: red <60, amber 60–80, green ≥80.'
      ),
    ),
  );

  // Filter bar
  const filterRow = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:12px;' },
    h('label', { style: 'font-size:12px;color:var(--fg2);' }, 'Tenant ID:'),
    h('input', {
      type: 'text',
      value: matrixState.tenantFilter,
      placeholder: '(global / blank for all)',
      style: 'padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;width:240px;',
      onInput: (e: Event) => { matrixState.tenantFilter = (e.target as HTMLInputElement).value; },
    }),
    h('button', {
      style: 'padding:5px 12px;font-size:12px;cursor:pointer;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);',
      onClick: () => { void loadHeatmap(render); },
    }, 'Reload'),
    h('span', { style: 'font-size:11px;color:var(--fg2);margin-left:auto;' },
      `${matrixState.models.length} model rows · ${matrixState.taskKeys.length} task types`),
  );
  container.appendChild(filterRow);

  if (matrixState.loading) {
    container.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;' }, 'Loading capability scores…'));
    return container;
  }

  if (matrixState.error) {
    container.appendChild(h('div', {
      style: 'color:#c62828;font-size:13px;padding:10px;background:#fce8e6;border-radius:4px;',
    }, matrixState.error));
    return container;
  }

  if (matrixState.models.length === 0) {
    container.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;padding:14px;border:1px dashed var(--border);border-radius:6px;' },
      'No capability scores recorded yet. Add rows via POST /api/admin/capability-scores or seed in DB.'));
    return container;
  }

  // Table
  const wrap = h('div', { style: 'overflow:auto;border:1px solid var(--border);border-radius:6px;' });
  const table = h('table', { style: 'border-collapse:collapse;font-size:12px;width:100%;' });

  const thead = h('thead', null);
  const headRow = h('tr', { style: 'background:var(--bg2,#f5f5f5);' });
  headRow.appendChild(h('th', { style: 'padding:8px;text-align:left;position:sticky;left:0;background:var(--bg2,#f5f5f5);border-right:1px solid var(--border);' }, 'Provider / Model'));
  headRow.appendChild(h('th', { style: 'padding:8px;text-align:left;border-right:1px solid var(--border);' }, 'Tenant'));
  for (const tk of matrixState.taskKeys) {
    headRow.appendChild(h('th', { style: 'padding:8px 6px;text-align:center;font-weight:500;', title: tk }, tk));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = h('tbody', null);
  for (const model of matrixState.models) {
    const row = h('tr', null);
    row.appendChild(h('td', { style: 'padding:6px 8px;border-top:1px solid var(--border);position:sticky;left:0;background:var(--bg);font-weight:500;border-right:1px solid var(--border);' },
      `${model.provider}/${model.model_id}`));
    row.appendChild(h('td', { style: 'padding:6px 8px;border-top:1px solid var(--border);color:var(--fg2);border-right:1px solid var(--border);' },
      model.tenant_id ?? '(global)'));
    for (const tk of matrixState.taskKeys) {
      const score = model.scores[tk];
      row.appendChild(h('td', {
        style: `padding:6px;text-align:center;border-top:1px solid var(--border);${cellColor(score)}`,
        title: score != null ? `${tk}: ${score}` : `${tk}: no score`,
      }, score != null ? String(score) : '—'));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  return container;
}
