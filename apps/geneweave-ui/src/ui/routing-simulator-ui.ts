/**
 * GeneWeave — Routing Simulator UI (anyWeave Phase 4 / M16)
 *
 * Operator-facing preview for the task-aware router. Lets operators choose a
 * task type, optional tenant, capability requirements, and weights, then runs
 * the simulator endpoint and renders the ranked candidate breakdown.
 * Rendered when admin tab schema has customView = 'routing-simulator'.
 */

import { h } from './dom.js';
import { api } from './api.js';

interface TaskType {
  task_key: string;
  display_name: string;
  category: string;
  default_strategy: string;
  default_weights: string;
  enabled: number;
}

interface CandidateBreakdown {
  cost: number;
  speed: number;
  quality: number;
  capability: number;
}

interface Candidate {
  modelId: string;
  provider: string;
  capabilityScore: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  estimatedCostPer1M: number | null;
  breakdown: CandidateBreakdown;
  overall: number;
}

interface SimResult {
  weightsUsed: { cost: number; speed: number; quality: number; capability: number };
  weightSource: string;
  candidatesEvaluated: number;
  candidates: Candidate[];
  winner: Candidate | null;
  traceId: string | null;
}

interface SimState {
  taskTypes: TaskType[];
  loadingTaskTypes: boolean;
  taskTypesLoaded: boolean;
  selectedTaskKey: string;
  tenantId: string;
  weights: { cost: number; speed: number; quality: number; capability: number };
  weightsOverride: boolean;
  requireTools: boolean;
  requireVision: boolean;
  requireStreaming: boolean;
  requireJsonMode: boolean;
  persist: boolean;
  running: boolean;
  result: SimResult | null;
  error: string | null;
}

const simState: SimState = {
  taskTypes: [],
  loadingTaskTypes: false,
  taskTypesLoaded: false,
  selectedTaskKey: '',
  tenantId: '',
  weights: { cost: 0.25, speed: 0.25, quality: 0.25, capability: 0.25 },
  weightsOverride: false,
  requireTools: false,
  requireVision: false,
  requireStreaming: false,
  requireJsonMode: false,
  persist: false,
  running: false,
  result: null,
  error: null,
};

async function loadTaskTypes(render: () => void): Promise<void> {
  simState.loadingTaskTypes = true;
  render();
  try {
    const r = await api.get('/admin/task-types');
    if (r.ok) {
      const data = await r.json();
      simState.taskTypes = (data.taskTypes ?? []).filter((t: TaskType) => t.enabled);
      if (simState.taskTypes.length > 0 && !simState.selectedTaskKey) {
        simState.selectedTaskKey = simState.taskTypes[0]!.task_key;
      }
      simState.taskTypesLoaded = true;
    } else {
      simState.error = `Failed to load task types: HTTP ${r.status}`;
    }
  } catch (err) {
    simState.error = err instanceof Error ? err.message : String(err);
  } finally {
    simState.loadingTaskTypes = false;
    render();
  }
}

async function runSimulation(render: () => void): Promise<void> {
  if (!simState.selectedTaskKey) return;
  simState.running = true;
  simState.error = null;
  simState.result = null;
  render();
  try {
    const body: Record<string, unknown> = {
      taskKey: simState.selectedTaskKey,
      requireTools: simState.requireTools,
      requireVision: simState.requireVision,
      requireStreaming: simState.requireStreaming,
      requireJsonMode: simState.requireJsonMode,
      persist: simState.persist,
    };
    if (simState.tenantId.trim()) body['tenantId'] = simState.tenantId.trim();
    if (simState.weightsOverride) body['weights'] = simState.weights;
    const r = await api.post('/admin/routing-simulator', body);
    if (!r.ok) {
      const txt = await r.text();
      simState.error = `Simulation failed: HTTP ${r.status} ${txt}`;
    } else {
      simState.result = await r.json();
    }
  } catch (err) {
    simState.error = err instanceof Error ? err.message : String(err);
  } finally {
    simState.running = false;
    render();
  }
}

function num(v: number, digits = 3): string { return v.toFixed(digits); }

function flagBadge(label: string, on: boolean): HTMLElement {
  return h('span', {
    style: `display:inline-block;padding:1px 6px;margin-right:4px;font-size:10px;border-radius:3px;${on ? 'background:#e8f5e9;color:#1b5e20;' : 'background:#f5f5f5;color:#999;'}`,
  }, label);
}

export function renderRoutingSimulatorView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  if (!simState.taskTypesLoaded && !simState.loadingTaskTypes) {
    void loadTaskTypes(render);
  }

  const container = h('div', { className: 'routing-sim-container', style: 'max-width:1100px;' },
    h('div', { style: 'margin-bottom:14px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'Routing Simulator'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Preview the model that the task-aware router would select for a given task and tenant. Results never affect production traffic unless you check Persist trace.'),
    ),
  );

  if (simState.loadingTaskTypes) {
    container.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;' }, 'Loading task types…'));
    return container;
  }

  // Form
  const form = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:14px;' });

  // Left column
  const left = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' });

  const taskSelect = h('select', {
    style: 'padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px;width:100%;',
    onChange: (e: Event) => { simState.selectedTaskKey = (e.target as HTMLSelectElement).value; },
  });
  for (const t of simState.taskTypes) {
    const opt = h('option', { value: t.task_key }, `${t.display_name} (${t.task_key})`);
    if (t.task_key === simState.selectedTaskKey) (opt as HTMLOptionElement).selected = true;
    taskSelect.appendChild(opt);
  }
  left.appendChild(h('div', null, h('label', { style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;' }, 'Task Type'), taskSelect));

  left.appendChild(h('div', null,
    h('label', { style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;' }, 'Tenant ID (optional)'),
    h('input', {
      type: 'text', value: simState.tenantId, placeholder: '(leave blank for global)',
      style: 'padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px;width:100%;',
      onInput: (e: Event) => { simState.tenantId = (e.target as HTMLInputElement).value; },
    }),
  ));

  // Capability filters
  const filterFlags = h('div', null,
    h('label', { style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;' }, 'Capability Requirements'),
    h('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;font-size:12px;' },
      ...(['requireTools', 'requireVision', 'requireStreaming', 'requireJsonMode'] as const).map(key =>
        h('label', { style: 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;' },
          h('input', {
            type: 'checkbox', checked: simState[key],
            onChange: (e: Event) => { simState[key] = (e.target as HTMLInputElement).checked; },
          }),
          key.replace('require', ''),
        )
      ),
    ),
  );
  left.appendChild(filterFlags);

  left.appendChild(h('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;' },
    h('input', {
      type: 'checkbox', checked: simState.persist,
      onChange: (e: Event) => { simState.persist = (e.target as HTMLInputElement).checked; },
    }),
    'Persist trace to routing_decision_traces',
  ));

  // Right column — weights
  const right = h('div', { style: 'display:flex;flex-direction:column;gap:8px;' });
  right.appendChild(h('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;' },
    h('input', {
      type: 'checkbox', checked: simState.weightsOverride,
      onChange: (e: Event) => { simState.weightsOverride = (e.target as HTMLInputElement).checked; render(); },
    }),
    'Override weights (otherwise use task-type / tenant defaults)',
  ));

  for (const dim of ['cost', 'speed', 'quality', 'capability'] as const) {
    const row = h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12px;' },
      h('label', { style: `width:80px;color:${simState.weightsOverride ? 'var(--fg)' : 'var(--fg2)'};` }, dim),
      h('input', {
        type: 'range', min: '0', max: '1', step: '0.05', value: String(simState.weights[dim]),
        disabled: !simState.weightsOverride,
        style: 'flex:1;',
        onInput: (e: Event) => {
          simState.weights[dim] = Number((e.target as HTMLInputElement).value);
          render();
        },
      }),
      h('span', { style: 'width:40px;text-align:right;font-variant-numeric:tabular-nums;' }, num(simState.weights[dim], 2)),
    );
    right.appendChild(row);
  }

  form.appendChild(left);
  form.appendChild(right);
  container.appendChild(form);

  // Action row
  const actions = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:14px;' },
    h('button', {
      style: `padding:8px 18px;font-size:13px;cursor:${simState.running ? 'not-allowed' : 'pointer'};border:1px solid var(--accent,#1976d2);border-radius:4px;background:var(--accent,#1976d2);color:#fff;font-weight:500;`,
      disabled: simState.running || !simState.selectedTaskKey,
      onClick: () => { void runSimulation(render); },
    }, simState.running ? 'Running…' : 'Run Simulation'),
    simState.result?.traceId ? h('span', { style: 'font-size:11px;color:var(--fg2);' }, `Trace: ${simState.result.traceId}`) : null,
  );
  container.appendChild(actions);

  if (simState.error) {
    container.appendChild(h('div', { style: 'color:#c62828;font-size:13px;padding:10px;background:#fce8e6;border-radius:4px;margin-bottom:14px;' }, simState.error));
  }

  if (!simState.result) return container;

  // Result panel
  const r = simState.result;
  const resultHeader = h('div', { style: 'background:var(--bg2,#f5f5f5);padding:10px 14px;border-radius:6px 6px 0 0;border:1px solid var(--border);font-size:12px;' },
    h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;' },
      h('div', null, h('strong', null, 'Weight source: '), r.weightSource),
      h('div', null, h('strong', null, 'Weights: '), `cost=${num(r.weightsUsed.cost, 2)}, speed=${num(r.weightsUsed.speed, 2)}, quality=${num(r.weightsUsed.quality, 2)}, capability=${num(r.weightsUsed.capability, 2)}`),
      h('div', null, h('strong', null, 'Candidates evaluated: '), String(r.candidatesEvaluated)),
    ),
  );
  container.appendChild(resultHeader);

  if (r.candidates.length === 0) {
    container.appendChild(h('div', { style: 'border:1px solid var(--border);border-top:0;border-radius:0 0 6px 6px;padding:14px;color:var(--fg2);font-size:13px;' },
      'No candidates matched. Either no capability scores exist for this task, or your filters excluded everything.'));
    return container;
  }

  // Candidate table
  const wrap = h('div', { style: 'overflow:auto;border:1px solid var(--border);border-top:0;border-radius:0 0 6px 6px;' });
  const table = h('table', { style: 'border-collapse:collapse;font-size:12px;width:100%;' });
  const thead = h('thead', null);
  const headRow = h('tr', { style: 'background:var(--bg2,#fafafa);' });
  for (const col of ['#', 'Provider/Model', 'Overall', 'Cost', 'Speed', 'Quality', 'Capability', 'Cost/1M', 'Flags']) {
    headRow.appendChild(h('th', { style: 'padding:8px;text-align:left;font-weight:500;border-bottom:1px solid var(--border);' }, col));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = h('tbody', null);
  r.candidates.forEach((c, idx) => {
    const isWinner = idx === 0;
    const row = h('tr', { style: isWinner ? 'background:#e8f5e9;' : '' });
    row.appendChild(h('td', { style: 'padding:6px 8px;font-weight:500;' }, isWinner ? '★ 1' : String(idx + 1)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-family:monospace;' }, `${c.provider}/${c.modelId}`));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-weight:600;font-variant-numeric:tabular-nums;' }, num(c.overall)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-variant-numeric:tabular-nums;' }, num(c.breakdown.cost)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-variant-numeric:tabular-nums;' }, num(c.breakdown.speed)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-variant-numeric:tabular-nums;' }, num(c.breakdown.quality)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-variant-numeric:tabular-nums;' }, num(c.breakdown.capability)));
    row.appendChild(h('td', { style: 'padding:6px 8px;font-variant-numeric:tabular-nums;color:var(--fg2);' }, c.estimatedCostPer1M != null ? `$${c.estimatedCostPer1M.toFixed(2)}` : '—'));
    row.appendChild(h('td', { style: 'padding:6px 8px;' },
      flagBadge('tools', c.supportsTools),
      flagBadge('stream', c.supportsStreaming),
      flagBadge('vision', c.supportsVision),
      flagBadge('json', c.supportsJsonMode),
    ));
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  return container;
}
