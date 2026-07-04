/**
 * GeneWeave — Tool Simulation UI (Phase 5)
 *
 * Step-through admin UI for testing tool invocations with full policy trace visibility.
 * Rendered when admin tab schema has customView = 'tool-simulation'.
 *
 * Flow:
 *   1. Select tool from catalog
 *   2. View resolved effective policy
 *   3. Enter input JSON arguments
 *   4. Run (or dry-run) → see policy trace + result
 */

import { h } from './dom.js';
import { api } from './api.js';

interface SimTool {
  key: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
  sampleInputJson?: string;
}

interface PolicyTraceEntry {
  step: string;
  passed: boolean;
  detail: string;
}

interface SimulationResult {
  simulationId: string;
  auditEventId: string;
  toolName: string;
  dryRun: boolean;
  policy: Record<string, unknown>;
  policyTrace: PolicyTraceEntry[];
  allowed: boolean;
  violationReason?: string;
  result?: { content: string; isError?: boolean };
  durationMs: number;
}

interface SimState {
  tools: SimTool[];
  loading: boolean;
  selectedTool: string;
  inputJson: string;
  hydratedToolKey: string;
  agentPersona: string;
  skillPolicyKey: string;
  running: boolean;
  lastResult: SimulationResult | null;
  error: string | null;
  showPolicy: boolean;
  loadingTools: boolean;
}

const simState: SimState = {
  tools: [],
  loading: false,
  selectedTool: '',
  inputJson: '{}',
  hydratedToolKey: '',
  agentPersona: '',
  skillPolicyKey: '',
  running: false,
  lastResult: null,
  error: null,
  showPolicy: false,
  loadingTools: false,
};

function stepLabel(step: string): string {
  const labels: Record<string, string> = {
    enabled_check: 'Enabled Check',
    risk_level_gate: 'Risk Level Gate',
    approval_gate: 'Approval Gate',
    rate_limit: 'Rate Limit',
    timeout: 'Timeout Policy',
  };
  return labels[step] ?? step;
}

function renderPolicyTrace(trace: PolicyTraceEntry[]): HTMLElement {
  return h('div', { className: 'sim-policy-trace' },
    h('h4', { style: 'margin:0 0 8px;font-size:13px;color:var(--fg2);' }, 'Policy Enforcement Trace'),
    ...trace.map(entry =>
      h('div', {
        className: `sim-trace-entry ${entry.passed ? 'sim-trace-pass' : 'sim-trace-fail'}`,
        style: `display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-radius:4px;margin-bottom:4px;background:${entry.passed ? 'var(--success-bg,#e6f4ea)' : 'var(--error-bg,#fce8e6)'};`,
      },
        h('span', { style: `font-size:14px;line-height:1.4;min-width:16px;color:${entry.passed ? '#1e7e34' : '#c62828'};` },
          entry.passed ? '✓' : '✗'
        ),
        h('div', { style: 'flex:1;' },
          h('div', { style: 'font-size:12px;font-weight:600;color:var(--fg1);' }, stepLabel(entry.step)),
          h('div', { style: 'font-size:11px;color:var(--fg2);margin-top:2px;' }, entry.detail)
        )
      )
    )
  );
}

function renderPolicyDetails(policy: Record<string, unknown>): HTMLElement {
  const fields: Array<[string, string]> = [
    ['enabled', 'Enabled'],
    ['source', 'Policy Source'],
    ['policyId', 'Policy ID'],
    ['allowedRiskLevels', 'Allowed Risk Levels'],
    ['requiresApproval', 'Requires Approval'],
    ['rateLimitPerMinute', 'Rate Limit (per min)'],
    ['timeoutMs', 'Timeout (ms)'],
    ['logInputOutput', 'Log Input/Output'],
  ];

  return h('div', { className: 'sim-policy-details', style: 'margin-top:8px;' },
    h('h4', { style: 'margin:0 0 8px;font-size:13px;color:var(--fg2);' }, 'Effective Policy'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;' },
      ...fields.map(([key, label]) => {
        const val = policy[key];
        if (val === undefined || val === null) return null!;
        const display = Array.isArray(val) ? val.join(', ') : String(val);
        return h('div', { style: 'font-size:11px;padding:3px 0;border-bottom:1px solid var(--border1);' },
          h('span', { style: 'color:var(--fg2);' }, label + ': '),
          h('span', { style: 'color:var(--fg1);font-weight:500;' }, display)
        );
      }).filter(Boolean)
    )
  );
}

async function loadSimulationTools(render: () => void): Promise<void> {
  simState.loadingTools = true;
  simState.error = null;
  render();
  try {
    const resp = await api.get('/api/admin/tool-simulation/tools');
    const data = await resp.json() as { tools?: SimTool[] };
    simState.tools = data.tools ?? [];
    const fallbackTool = simState.tools[0];
    const selectedTool = simState.tools.find(t => t.key === simState.selectedTool) ?? fallbackTool;
    if (selectedTool) {
      simState.selectedTool = selectedTool.key;
      if (!simState.inputJson.trim() || simState.inputJson.trim() === '{}' || simState.hydratedToolKey !== selectedTool.key) {
        simState.inputJson = selectedTool.sampleInputJson ?? '{}';
        simState.hydratedToolKey = selectedTool.key;
      }
    }
  } catch (err) {
    simState.error = `Failed to load tools: ${(err as Error).message}`;
  }
  simState.loadingTools = false;
  render();
}

async function runSimulation(dryRun: boolean, render: () => void): Promise<void> {
  if (!simState.selectedTool) {
    simState.error = 'Please select a tool';
    render();
    return;
  }

  simState.running = true;
  simState.lastResult = null;
  simState.error = null;
  render();

  try {
    const chatContext: Record<string, string> = {};
    if (simState.agentPersona) chatContext['agentPersona'] = simState.agentPersona;
    if (simState.skillPolicyKey) chatContext['skillPolicyKey'] = simState.skillPolicyKey;

    const resp = await api.post('/api/admin/tool-simulation', {
      toolName: simState.selectedTool,
      inputJson: simState.inputJson || '{}',
      dryRun,
      chatContext,
    });
    const result = await resp.json() as SimulationResult;

    simState.lastResult = result;
    simState.showPolicy = true;
  } catch (err) {
    simState.error = `Simulation failed: ${(err as Error).message}`;
  }

  simState.running = false;
  render();
}

export function renderToolSimulationView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  // Load tools on first render
  if (simState.tools.length === 0 && !simState.loadingTools) {
    void loadSimulationTools(render);
  }

  const selectedToolInfo = simState.tools.find(t => t.key === simState.selectedTool);
  if (selectedToolInfo && (!simState.inputJson.trim() || simState.inputJson.trim() === '{}' || simState.hydratedToolKey !== selectedToolInfo.key)) {
    simState.inputJson = selectedToolInfo.sampleInputJson ?? '{}';
    simState.hydratedToolKey = selectedToolInfo.key;
  }

  const container = h('div', { className: 'sim-container', style: 'max-width:900px;' },
    // Header
    h('div', { style: 'margin-bottom:16px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'Tool Simulation'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Test tool invocations with full policy enforcement trace before enabling in production.'
      )
    )
  );

  if (simState.loadingTools) {
    container.appendChild(h('div', { style: 'color:var(--fg2);font-size:13px;' }, 'Loading tools…'));
    return container;
  }

  if (simState.error && simState.tools.length === 0) {
    container.appendChild(h('div', {
      style: 'color:var(--error,#c62828);font-size:13px;padding:10px;background:var(--error-bg,#fce8e6);border-radius:4px;',
    }, simState.error));
    return container;
  }

  // Layout: left panel (config) + right panel (results)
  const layout = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;' });

  // ── Left Panel: Tool Selection + Input ──────────────────
  const leftPanel = h('div', { className: 'sim-left-panel' });

  // Tool selector
  const toolSelect = h('select', {
    className: 'admin-field-input',
    style: 'width:100%;margin-bottom:8px;',
    onChange: (e: Event) => {
      simState.selectedTool = (e.target as HTMLSelectElement).value;
      const nextTool = simState.tools.find(t => t.key === simState.selectedTool);
      simState.inputJson = nextTool?.sampleInputJson ?? '{}';
      simState.hydratedToolKey = nextTool?.key ?? '';
      simState.lastResult = null;
      render();
    },
  },
    h('option', { value: '' }, '— Select a tool —'),
    ...simState.tools.map(t =>
      h('option', {
        value: t.key,
        selected: simState.selectedTool === t.key,
      }, `${t.name} (${t.source})`)
    )
  ) as HTMLSelectElement;
  leftPanel.appendChild(h('div', { className: 'admin-field-group' },
    h('label', { className: 'admin-field-label', style: 'font-size:12px;' }, 'Tool'),
    toolSelect
  ));

  // Tool description
  if (selectedToolInfo) {
    leftPanel.appendChild(h('p', {
      style: 'font-size:11px;color:var(--fg2);margin:0 0 12px;line-height:1.5;',
    }, selectedToolInfo.description));
  }

  // Input JSON
  const inputArea = h('textarea', {
    className: 'admin-field-textarea',
    placeholder: '{\n  "query": "hello world"\n}',
    style: 'width:100%;height:140px;font-family:monospace;font-size:12px;resize:vertical;',
    value: simState.inputJson,
    onInput: (e: Event) => {
      simState.inputJson = (e.target as HTMLTextAreaElement).value;
      simState.hydratedToolKey = simState.selectedTool;
    },
  }) as HTMLTextAreaElement;
  leftPanel.appendChild(h('div', { className: 'admin-field-group' },
    h('label', { className: 'admin-field-label', style: 'font-size:12px;' }, 'Input JSON (tool arguments)'),
    inputArea
  ));

  // Context options (collapsed by default into a details element)
  const contextDetails = h('details', { style: 'margin-bottom:12px;' },
    h('summary', { style: 'font-size:12px;color:var(--fg2);cursor:pointer;user-select:none;' }, 'Context options'),
    h('div', { style: 'margin-top:8px;display:grid;gap:6px;' },
      h('div', { className: 'admin-field-group' },
        h('label', { className: 'admin-field-label', style: 'font-size:11px;' }, 'Agent Persona (optional)'),
        h('input', {
          type: 'text',
          className: 'admin-field-input',
          placeholder: 'e.g. agent_researcher',
          value: simState.agentPersona,
          onInput: (e: Event) => { simState.agentPersona = (e.target as HTMLInputElement).value; },
        })
      ),
      h('div', { className: 'admin-field-group' },
        h('label', { className: 'admin-field-label', style: 'font-size:11px;' }, 'Skill Policy Key (optional)'),
        h('input', {
          type: 'text',
          className: 'admin-field-input',
          placeholder: 'e.g. strict_external',
          value: simState.skillPolicyKey,
          onInput: (e: Event) => { simState.skillPolicyKey = (e.target as HTMLInputElement).value; },
        })
      )
    )
  );
  leftPanel.appendChild(contextDetails);

  // Action buttons
  const btnRow = h('div', { style: 'display:flex;gap:8px;' },
    h('button', {
      className: 'admin-save-btn',
      disabled: simState.running || !simState.selectedTool,
      onClick: () => { void runSimulation(false, render); },
    }, simState.running ? 'Running…' : 'Run Simulation'),
    h('button', {
      className: 'nav-btn',
      style: 'font-size:12px;',
      disabled: simState.running || !simState.selectedTool,
      onClick: () => { void runSimulation(true, render); },
    }, 'Dry Run (policy only)')
  );
  leftPanel.appendChild(btnRow);

  if (simState.error) {
    leftPanel.appendChild(h('div', {
      style: 'margin-top:10px;color:var(--error,#c62828);font-size:12px;padding:8px;background:var(--error-bg,#fce8e6);border-radius:4px;',
    }, simState.error));
  }

  layout.appendChild(leftPanel);

  // ── Right Panel: Results ─────────────────────────────────
  const rightPanel = h('div', { className: 'sim-right-panel' });

  if (simState.lastResult) {
    const r = simState.lastResult;

    // Status banner
    const statusColor = r.allowed ? (r.result?.isError ? '#e65100' : '#1e7e34') : '#c62828';
    const statusText = !r.allowed
      ? `Blocked — ${r.violationReason ?? 'policy violation'}`
      : r.dryRun
        ? 'Dry run complete — policy check passed'
        : r.result?.isError
          ? 'Execution error'
          : 'Execution successful';
    rightPanel.appendChild(h('div', {
      style: `padding:8px 12px;border-radius:4px;margin-bottom:12px;background:${r.allowed ? (r.result?.isError ? '#fff3e0' : '#e6f4ea') : '#fce8e6'};font-size:12px;font-weight:600;color:${statusColor};`,
    },
      `${r.dryRun ? '[Dry Run] ' : ''}${statusText} · ${r.durationMs}ms · ID: ${r.simulationId.slice(0, 8)}…`
    ));

    // Policy trace
    rightPanel.appendChild(renderPolicyTrace(r.policyTrace));

    // Effective policy toggle
    if (simState.showPolicy) {
      rightPanel.appendChild(renderPolicyDetails(r.policy));
    }

    const toggleBtn = h('button', {
      className: 'nav-btn',
      style: 'font-size:11px;margin-top:8px;',
      onClick: () => { simState.showPolicy = !simState.showPolicy; render(); },
    }, simState.showPolicy ? 'Hide policy details' : 'Show policy details');
    rightPanel.appendChild(toggleBtn);

    // Execution result
    if (!r.dryRun && r.result !== undefined) {
      rightPanel.appendChild(h('div', { style: 'margin-top:12px;' },
        h('h4', { style: 'margin:0 0 6px;font-size:13px;color:var(--fg2);' }, 'Execution Result'),
        h('pre', {
          style: `background:var(--surface2,#f5f5f5);padding:10px;border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;color:${r.result.isError ? '#c62828' : 'var(--fg1)'};`,
        }, r.result.content || '(empty response)')
      ));
    }
  } else if (!simState.running) {
    rightPanel.appendChild(h('div', {
      style: 'padding:24px;text-align:center;color:var(--fg3);font-size:13px;border:1px dashed var(--border2,#ddd);border-radius:6px;',
    }, 'Select a tool and click "Run Simulation" or "Dry Run" to see policy trace and results.'));
  }

  layout.appendChild(rightPanel);
  container.appendChild(layout);
  return container;
}
