/**
 * GeneWeave — Kaggle Live Competition Runs UI (M21, refresh).
 *
 * The list view is rendered by the *shared* admin list (renderAdminView).
 * This file contributes two focused pieces:
 *
 *   1. renderKglRunRowActions(row, render)
 *      → A <td> appended to each list row (via buildAdminRow) containing
 *        hover-revealed Pause / Cancel / Restart buttons.
 *
 *   2. renderKglCompetitionRunDetail({ runId, render })
 *      → The custom record/detail panel rendered when a list row is opened.
 *        Replaces the auto-generated CRUD form for this tab. Activated via
 *        the schema field `customRecordView: 'kaggle-competition-runs'`.
 */

import { h } from './dom.js';
import { api } from './api.js';
import type {
  KglCompetitionRunRow,
  KglRunStepRow,
  KglRunEventRow,
  LiveAgentRow,
  LiveMeshRow,
  LiveMeshMessageView,
} from './types.js';

// ── Per-detail-panel state (single active record at a time) ─────────────

interface DetailState {
  loadedRunId: string | null;
  loading: boolean;
  error: string | null;
  run: KglCompetitionRunRow | null;
  steps: KglRunStepRow[];
  events: KglRunEventRow[];
  messages: LiveMeshMessageView[];
  agents: LiveAgentRow[];
  mesh: LiveMeshRow | null;
  busy: boolean;
  actionError: string | null;
}

const detail: DetailState = {
  loadedRunId: null,
  loading: false,
  error: null,
  run: null,
  steps: [],
  events: [],
  messages: [],
  agents: [],
  mesh: null,
  busy: false,
  actionError: null,
};

// busy state for list-view row actions, keyed by run id.
const rowBusy = new Map<string, boolean>();

// ── Helpers ─────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  queued: '#6b7280',
  running: '#2563eb',
  completed: '#16a34a',
  abandoned: '#9ca3af',
  failed: '#dc2626',
  paused: '#b45309',
};

function statusBadge(status: string): HTMLElement {
  const color = STATUS_COLOR[status] ?? '#6b7280';
  return h('span', {
    style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${color};`,
  }, status);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function durationMs(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function shortRef(ref: string): string {
  return ref.replace(/^https?:\/\/(?:www\.)?kaggle\.com\/competitions\//, '');
}

// ── Row actions (Cancel / Pause / Restart) ──────────────────────────────

let _stylesInjected = false;
function ensureStyles(): void {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .admin-data-row .kgl-row-actions { opacity: 0; transition: opacity .12s; }
    .admin-data-row:hover .kgl-row-actions,
    .admin-data-row:focus-within .kgl-row-actions { opacity: 1; }
  `;
  document.head.appendChild(style);
}

async function rowAction(
  runId: string,
  action: 'cancel' | 'pause' | 'restart',
  render: () => void,
): Promise<void> {
  rowBusy.set(runId, true);
  render();
  try {
    const resp = await api.post(
      `/api/admin/kaggle-competition-runs/${encodeURIComponent(runId)}/${action}`,
      {},
    );
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 160)}`);
    }
  } catch (err) {
    detail.actionError = `${action} failed: ${(err as Error).message}`;
  }
  rowBusy.delete(runId);
  // Re-pull list data + (if open) the detail.
  try {
    const refreshed = await api.get('/api/admin/kaggle-competition-runs?limit=200');
    const data = await refreshed.json() as { 'kaggle-competition-runs'?: KglCompetitionRunRow[] };
    const list = data['kaggle-competition-runs'] ?? [];
    // Update the shared adminData cache so the list refreshes in place.
    const adminState = (globalThis as any).state;
    if (adminState?.adminData) {
      adminState.adminData['kaggle-competition-runs'] = list;
    }
  } catch { /* non-fatal */ }
  if (detail.loadedRunId === runId) {
    await loadDetail(runId, render);
    return;
  }
  render();
}

function actionButton(
  label: string,
  title: string,
  color: string,
  busy: boolean,
  onClick: () => void,
): HTMLElement {
  return h('button', {
    className: 'admin-row-action-btn',
    title,
    disabled: busy,
    style: `background:transparent;border:1px solid var(--bg4);border-radius:6px;padding:3px 8px;`
      + `cursor:${busy ? 'wait' : 'pointer'};color:${color};font-size:11px;font-weight:600;`
      + `opacity:${busy ? 0.5 : 1};`,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      onClick();
    },
  }, label);
}

export function renderKglRunRowActions(row: any, render: () => void): HTMLElement {
  ensureStyles();
  const run = row as KglCompetitionRunRow;
  const busy = !!rowBusy.get(run.id);
  const isTerminal = run.status === 'completed' || run.status === 'abandoned' || run.status === 'failed';
  const isRunning = run.status === 'running' || run.status === 'queued';
  return h('td', {
    className: 'admin-action-cell',
    style: 'width:240px;text-align:right;white-space:nowrap;padding:4px 8px;',
  },
    h('div', {
      className: 'kgl-row-actions',
      style: 'display:inline-flex;gap:4px;',
    },
      isRunning ? actionButton('Pause', 'Pause this run (stops mesh ticks)', '#b45309', busy,
        () => { void rowAction(run.id, 'pause', render); }) : null,
      !isTerminal ? actionButton('Cancel', 'Cancel this run (mark abandoned, pause mesh)', '#dc2626', busy,
        () => { void rowAction(run.id, 'cancel', render); }) : null,
      run.mesh_id ? actionButton('Restart', 'Restart mesh + agents and resume run', '#2563eb', busy,
        () => { void rowAction(run.id, 'restart', render); }) : null,
    ),
  );
}

// ── Detail loader ───────────────────────────────────────────────────────

async function loadDetail(runId: string, render: () => void): Promise<void> {
  detail.loadedRunId = runId;
  detail.loading = true;
  detail.error = null;
  detail.run = null;
  detail.steps = [];
  detail.events = [];
  detail.messages = [];
  detail.agents = [];
  detail.mesh = null;
  render();
  try {
    const resp = await api.get(`/api/admin/kaggle-competition-runs/${encodeURIComponent(runId)}`);
    const data = await resp.json() as {
      'kaggle-competition-run'?: KglCompetitionRunRow;
      steps?: KglRunStepRow[];
      events?: KglRunEventRow[];
      messages?: LiveMeshMessageView[];
      agents?: LiveAgentRow[];
      mesh?: LiveMeshRow | null;
    };
    detail.run = data['kaggle-competition-run'] ?? null;
    detail.steps = (data.steps ?? []).slice().sort((a, b) => a.step_index - b.step_index);
    detail.events = (data.events ?? []).slice().sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
    detail.messages = data.messages ?? [];
    detail.agents = data.agents ?? [];
    detail.mesh = data.mesh ?? null;
  } catch (err) {
    detail.error = `Failed to load run: ${(err as Error).message}`;
  }
  detail.loading = false;
  render();
}

// ── Detail-view sub-renderers ───────────────────────────────────────────

function renderEventLine(ev: KglRunEventRow, agentMap: Map<string, string>): HTMLElement {
  const agentLabel = ev.agent_id ? (agentMap.get(ev.agent_id) ?? ev.agent_id.slice(0, 8)) : '';
  const hasPayload = !!ev.payload_json && ev.payload_json.length > 0;
  // Highlight backoff / circuit-open events so operators can immediately see
  // why a step looks frozen (instead of confusing them with the same blue
  // styling as ordinary step transitions).
  const kindColor = ev.kind === 'agent_circuit_open' ? '#dc2626'
    : ev.kind === 'agent_backoff' ? '#d97706'
    : '#2563eb';
  return h('div', { style: 'font-size:11px;padding:4px 0;border-bottom:1px dashed var(--bg4);' },
    h('div', { style: 'display:flex;gap:8px;align-items:flex-start;' },
      h('span', { style: 'color:var(--fg3);font-family:var(--mono,monospace);min-width:88px;' },
        fmtTime(ev.created_at)),
      h('span', { style: `color:${kindColor};font-weight:600;min-width:140px;` }, ev.kind),
      agentLabel ? h('span', { style: 'color:var(--fg2);min-width:100px;font-style:italic;' }, agentLabel) : null,
      ev.tool_key ? h('span', { style: 'color:#7c3aed;min-width:100px;font-family:var(--mono,monospace);' }, ev.tool_key) : null,
      h('span', { style: 'color:var(--fg);flex:1;word-break:break-word;' }, ev.summary),
    ),
    hasPayload ? h('details', { style: 'margin-top:4px;margin-left:88px;' },
      h('summary', { style: 'cursor:pointer;color:var(--fg3);font-size:10px;' }, 'payload'),
      h('pre', {
        style: 'margin:4px 0;padding:6px 8px;background:var(--bg);border:1px solid var(--bg4);border-radius:4px;'
          + 'font-size:10px;color:var(--fg2);max-height:240px;overflow:auto;white-space:pre-wrap;',
      }, ev.payload_json ?? ''),
    ) : null,
  );
}

function renderStepCard(step: KglRunStepRow, events: KglRunEventRow[], agentMap: Map<string, string>): HTMLElement {
  const stepEvents = events.filter(e => e.step_id === step.id);
  const color = STATUS_COLOR[step.status] ?? '#6b7280';
  const agentLabel = step.agent_id ? (agentMap.get(step.agent_id) ?? step.agent_id) : null;
  // Surface the latest backoff/circuit-open event as a banner at the top of
  // the step card so operators see "step is paused because…" without having
  // to scroll through the event log. We pick the most recent backoff-class
  // event AFTER any later step_started/step_completed (so a recovered step
  // doesn't keep showing a stale warning).
  let pauseBanner: HTMLElement | null = null;
  for (let i = stepEvents.length - 1; i >= 0; i--) {
    const ev = stepEvents[i];
    if (!ev) continue;
    if (ev.kind === 'step_completed' || ev.kind === 'step_started') break;
    if (ev.kind === 'agent_backoff' || ev.kind === 'agent_circuit_open') {
      const isCircuit = ev.kind === 'agent_circuit_open';
      pauseBanner = h('div', {
        style: `margin-bottom:8px;padding:8px 10px;border-radius:4px;font-size:12px;`
          + `background:${isCircuit ? '#fee2e2' : '#fef3c7'};`
          + `border:1px solid ${isCircuit ? '#dc2626' : '#d97706'};`
          + `color:${isCircuit ? '#991b1b' : '#92400e'};`,
      },
        h('strong', {}, isCircuit ? '⛔ Circuit open — ' : '⏸ Paused — '),
        ev.summary,
      );
      break;
    }
  }
  return h('div', {
    style: `border-left:3px solid ${color};padding:10px 12px;margin-bottom:10px;background:var(--bg2);border-radius:4px;`,
  },
    pauseBanner,
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;' },
      h('div', { style: 'flex:1;' },
        h('span', { style: 'font-size:11px;color:var(--fg3);margin-right:8px;' }, `Step ${step.step_index + 1}`),
        h('span', { style: 'font-size:13px;font-weight:600;' }, step.title),
      ),
      statusBadge(step.status),
    ),
    h('div', { style: 'font-size:11px;color:var(--fg3);margin-bottom:6px;' },
      `Role: ${step.role}`,
      agentLabel ? ` · Agent: ${agentLabel}` : '',
    ),
    step.description ? h('div', { style: 'font-size:12px;color:var(--fg);margin-bottom:6px;' }, step.description) : null,
    step.summary ? h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:6px;font-style:italic;' }, step.summary) : null,
    step.input_preview ? h('details', { style: 'margin-bottom:4px;' },
      h('summary', { style: 'cursor:pointer;color:var(--fg3);font-size:11px;' }, 'input preview'),
      h('pre', { style: 'margin:4px 0;padding:6px 8px;background:var(--bg);border:1px solid var(--bg4);border-radius:4px;font-size:10px;max-height:200px;overflow:auto;white-space:pre-wrap;' }, step.input_preview),
    ) : null,
    step.output_preview ? h('details', { style: 'margin-bottom:4px;' },
      h('summary', { style: 'cursor:pointer;color:var(--fg3);font-size:11px;' }, 'output preview'),
      h('pre', { style: 'margin:4px 0;padding:6px 8px;background:var(--bg);border:1px solid var(--bg4);border-radius:4px;font-size:10px;max-height:200px;overflow:auto;white-space:pre-wrap;' }, step.output_preview),
    ) : null,
    h('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--fg3);' },
      h('span', {}, `Started: ${fmtDate(step.started_at)}`),
      h('span', {}, `Completed: ${fmtDate(step.completed_at)}`),
      step.started_at ? h('span', {}, `Duration: ${durationMs(step.started_at, step.completed_at)}`) : null,
    ),
    stepEvents.length > 0 ? h('div', { style: 'margin-top:8px;padding-top:8px;border-top:1px dashed var(--bg4);' },
      h('div', { style: 'font-size:11px;color:var(--fg3);margin-bottom:4px;' }, `${stepEvents.length} event(s)`),
      ...stepEvents.map(ev => renderEventLine(ev, agentMap)),
    ) : null,
  );
}

function renderMessageRow(m: LiveMeshMessageView, agentMap: Map<string, string>): HTMLElement {
  const fromLabel = m.fromId ? (agentMap.get(m.fromId) ?? `${m.fromType ?? '?'}:${m.fromId.slice(0, 10)}`) : (m.fromType ?? '?');
  const toLabel = m.toId ? (agentMap.get(m.toId) ?? `${m.toType ?? '?'}:${m.toId.slice(0, 10)}`) : (m.toType ?? '?');
  const isTask = m.kind === 'TASK';
  return h('div', {
    style: `padding:10px 12px;margin-bottom:8px;background:var(--bg2);border-left:3px solid ${isTask ? '#2563eb' : '#7c3aed'};border-radius:4px;`,
  },
    h('div', { style: 'display:flex;gap:8px;align-items:center;font-size:11px;color:var(--fg3);margin-bottom:4px;' },
      h('span', { style: 'font-family:var(--mono,monospace);' }, fmtTime(m.createdAt)),
      h('span', { style: 'color:var(--fg);font-weight:600;' }, fromLabel),
      h('span', {}, '→'),
      h('span', { style: 'color:var(--fg);font-weight:600;' }, toLabel),
      m.kind ? h('span', { style: 'padding:1px 6px;border-radius:8px;background:var(--bg3);color:var(--fg2);font-size:10px;' }, m.kind) : null,
      m.topic ? h('span', { style: 'color:#7c3aed;font-family:var(--mono,monospace);font-size:10px;' }, m.topic) : null,
      m.status ? h('span', { style: 'margin-left:auto;color:var(--fg3);font-size:10px;' }, m.status) : null,
    ),
    m.subject ? h('div', { style: 'font-size:12px;font-weight:600;color:var(--fg);margin-bottom:4px;' }, m.subject) : null,
    m.body ? h('details', { style: 'margin-top:2px;' },
      h('summary', { style: 'cursor:pointer;color:var(--fg3);font-size:11px;' },
        `body (${m.body.length} chars)`),
      h('pre', {
        style: 'margin:6px 0 0;padding:8px;background:var(--bg);border:1px solid var(--bg4);border-radius:4px;'
          + 'font-size:11px;color:var(--fg2);max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;',
      }, m.body),
    ) : null,
  );
}

// ── Public detail entry ─────────────────────────────────────────────────

export function renderKglCompetitionRunDetail(opts: { runId: string; render: () => void }): HTMLElement {
  const { runId, render } = opts;
  ensureStyles();

  // First open of this record → kick off the load.
  if (detail.loadedRunId !== runId && !detail.loading) {
    void loadDetail(runId, render);
  }

  if (detail.loading) {
    return h('div', { style: 'padding:14px;color:var(--fg2);font-size:13px;' }, 'Loading run detail…');
  }
  if (detail.error) {
    return h('div', { style: 'padding:14px;color:#dc2626;font-size:13px;' }, detail.error);
  }
  const run = detail.run;
  if (!run) {
    return h('div', { style: 'padding:14px;color:var(--fg3);font-size:13px;' }, 'Run not found.');
  }

  const agentMap = new Map<string, string>();
  for (const a of detail.agents) {
    agentMap.set(a.id, `${a.role_label || a.role_key} (${a.name})`);
  }
  const orphanEvents = detail.events.filter(e => !e.step_id);
  const busy = !!rowBusy.get(run.id);
  const isTerminal = run.status === 'completed' || run.status === 'abandoned' || run.status === 'failed';
  const isRunning = run.status === 'running' || run.status === 'queued';

  return h('div', { style: 'padding:14px;display:flex;flex-direction:column;gap:14px;' },
    detail.actionError ? h('div', {
      style: 'padding:8px 12px;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5;border-radius:6px;font-size:12px;',
    }, detail.actionError) : null,

    // Header card with status + actions
    h('div', { style: 'border:1px solid var(--bg4);border-radius:8px;padding:14px;background:var(--bg2);' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;' },
        h('div', { style: 'flex:1;' },
          h('h3', { style: 'margin:0 0 4px;font-size:16px;color:var(--fg);' }, run.title || run.competition_ref),
          h('div', { style: 'font-size:11px;color:var(--fg3);font-family:var(--mono,monospace);' }, `Run ID: ${run.id}`),
          h('div', { style: 'font-size:11px;color:var(--fg3);font-family:var(--mono,monospace);' }, `Competition: ${run.competition_ref}`),
          run.mesh_id ? h('div', { style: 'font-size:11px;color:var(--fg3);font-family:var(--mono,monospace);' }, `Mesh: ${run.mesh_id}`) : null,
          detail.mesh ? h('div', { style: 'font-size:11px;color:var(--fg3);' },
            `Mesh status: ${detail.mesh.status} · ${detail.agents.length} agent(s)`) : null,
        ),
        h('div', { style: 'text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px;' },
          statusBadge(run.status),
          h('div', { style: 'font-size:11px;color:var(--fg3);' },
            `${run.step_count ?? 0} steps · ${run.event_count ?? 0} events · ${detail.messages.length} msgs`),
          h('div', { style: 'font-size:11px;color:var(--fg3);' }, `Started: ${fmtDate(run.started_at)}`),
          run.completed_at ? h('div', { style: 'font-size:11px;color:var(--fg3);' }, `Completed: ${fmtDate(run.completed_at)}`) : null,
          h('div', { style: 'display:flex;gap:6px;margin-top:6px;' },
            isRunning ? actionButton('Pause', 'Pause this run', '#b45309', busy,
              () => { void rowAction(run.id, 'pause', render); }) : null,
            !isTerminal ? actionButton('Cancel', 'Cancel this run', '#dc2626', busy,
              () => { void rowAction(run.id, 'cancel', render); }) : null,
            run.mesh_id ? actionButton('Restart', 'Restart mesh + agents', '#2563eb', busy,
              () => { void rowAction(run.id, 'restart', render); }) : null,
            h('button', {
              className: 'row-btn',
              onclick: () => { void loadDetail(run.id, render); },
            }, '↻ Refresh'),
          ),
        ),
      ),
      run.objective ? h('div', { style: 'margin-top:12px;padding:8px 10px;background:var(--bg);border-radius:4px;font-size:12px;' },
        h('div', { style: 'font-size:10px;color:var(--fg3);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px;' }, 'Objective'),
        run.objective,
      ) : null,
      run.summary ? h('div', { style: `margin-top:8px;padding:8px 10px;border-radius:4px;font-size:12px;background:${run.status === 'failed' ? '#fef2f2' : 'var(--bg)'};color:${run.status === 'failed' ? '#991b1b' : 'var(--fg)'};` },
        h('div', { style: 'font-size:10px;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.7;' },
          run.status === 'failed' ? 'Failure Reason' : 'Summary'),
        run.summary,
      ) : null,
    ),

    // Agents roster
    detail.agents.length > 0 ? h('div', {},
      h('h4', { style: 'margin:0 0 8px;font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' },
        `Agents (${detail.agents.length})`),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' },
        ...detail.agents.map(a => h('span', {
          style: `padding:3px 8px;border-radius:6px;background:var(--bg2);border:1px solid var(--bg4);font-size:11px;`
            + `color:${a.status === 'ACTIVE' ? '#16a34a' : 'var(--fg3)'};`,
          title: `id: ${a.id}\nstatus: ${a.status}\nattention: ${a.attention_policy_key ?? '—'}`,
        }, `${a.role_label || a.role_key}: ${a.name} · ${a.status}`)),
      ),
    ) : null,

    // Pipeline steps + events
    h('div', {},
      h('h4', { style: 'margin:0 0 8px;font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' },
        `Pipeline Steps (${detail.steps.length})`),
      detail.steps.length === 0
        ? h('div', { style: 'font-size:12px;color:var(--fg3);font-style:italic;' }, 'No steps recorded.')
        : h('div', {}, ...detail.steps.map(s => renderStepCard(s, detail.events, agentMap))),
    ),

    // Inter-agent dialogue
    h('div', {},
      h('h4', { style: 'margin:0 0 8px;font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' },
        `Agent Dialogue (${detail.messages.length})`),
      detail.messages.length === 0
        ? h('div', { style: 'font-size:12px;color:var(--fg3);font-style:italic;' },
            'No inter-agent messages recorded for this mesh.')
        : h('div', {}, ...detail.messages.map(m => renderMessageRow(m, agentMap))),
    ),

    // Run-level (orphan) events
    orphanEvents.length > 0 ? h('div', {},
      h('h4', { style: 'margin:0 0 8px;font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' },
        `Run-Level Events (${orphanEvents.length})`),
      h('div', { style: 'background:var(--bg2);padding:10px;border-radius:4px;border:1px solid var(--bg4);' },
        ...orphanEvents.map(ev => renderEventLine(ev, agentMap)),
      ),
    ) : null,
  );
}
