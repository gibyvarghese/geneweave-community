/**
 * Kaggle Competition — Flow Timeline view.
 *
 * Renders the per-run flow as a vertical timeline of step cards (one per
 * pipeline role) with a live event log streaming via SSE. Designed to feel
 * like reading a build log: each step has a status pill, role icon,
 * start/finish times, and inline details. The event rail on the right
 * shows fine-grained activity (mesh provisioning, tool calls, agent
 * messages) grouped by step.
 *
 * SSE cleanup follows the SV pattern — `MutationObserver` on `document.body`
 * detects when the view is removed from the DOM and closes `EventSource` +
 * clears the status poll interval.
 */
import { h } from '../../../ui/dom.js';
import { state } from '../../../ui/state.js';

const STEP_STATUS_COLOR: Record<string, string> = {
  pending: '#6b7280',
  running: '#f59e0b',
  completed: '#059669',
  failed: '#dc2626',
  skipped: '#94a3b8',
};

const RUN_STATUS_COLOR: Record<string, string> = {
  queued: '#6366f1',
  running: '#f59e0b',
  completed: '#059669',
  abandoned: '#6b7280',
  failed: '#dc2626',
};

const ROLE_ICON: Record<string, string> = {
  kaggle_discoverer: '🔭',
  kaggle_strategist: '🧭',
  kaggle_implementer: '🛠️',
  kaggle_validator: '✅',
  kaggle_submitter: '📤',
  kaggle_observer: '📡',
};

interface StepRow {
  id: string;
  step_index: number;
  role: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
}

interface RunHeader {
  id: string;
  competition_ref: string;
  title: string | null;
  status: string;
  mesh_id: string | null;
  step_count: number;
  event_count: number;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
}

interface EventFrame {
  id: string;
  stepId: string | null;
  kind: string;
  agentId: string | null;
  toolKey: string | null;
  summary: string;
  payload: unknown;
  createdAt: string;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function durationMs(start: string | null, end: string | null): string {
  if (!start) return '';
  const s = Date.parse(start);
  const e = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function renderKaggleFlowView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  const runId = (state as any).kaggleRunId as string | null;

  if (!runId) {
    return h('div', { className: 'dash-view' },
      h('p', { style: 'color:var(--fg3)' }, 'No competition run selected.'),
    );
  }

  // ── State refs ─────────────────────────────────────────────────────────
  let currentRun: RunHeader | null = null;
  let currentSteps: StepRow[] = [];
  const stepIndex = new Map<string, HTMLElement>(); // step id → card element

  const headerEl = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const statusPillEl = h('span', {
    style: 'font-size:11px;font-weight:700;color:white;background:#6b7280;border-radius:999px;padding:3px 10px;text-transform:uppercase;letter-spacing:.04em',
  }, 'loading');

  const stepsEl = h('div', { style: 'display:flex;flex-direction:column;gap:0' });
  const eventsEl = h('div', {
    style: 'display:flex;flex-direction:column;gap:6px;max-height:560px;overflow-y:auto;padding-right:6px',
  });
  const emptyEventsHint = h('div', {
    style: 'color:var(--fg3);font-size:12px;font-style:italic;padding:8px 4px',
  }, 'Waiting for events…');
  eventsEl.appendChild(emptyEventsHint);

  let statusPoll: ReturnType<typeof setInterval> | null = null;
  let eventsES: EventSource | null = null;

  function cleanup() {
    if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
    if (eventsES) { eventsES.close(); eventsES = null; }
  }

  // ── Step card builder ──────────────────────────────────────────────────
  function buildStepCard(step: StepRow, isLast: boolean): HTMLElement {
    const color = STEP_STATUS_COLOR[step.status] ?? '#6b7280';
    const icon = ROLE_ICON[step.role] ?? '⚙️';
    const dur = durationMs(step.started_at, step.completed_at);

    // Vertical-rail layout: dot + connector on left, card on right.
    const dot = h('div', {
      style: `width:14px;height:14px;border-radius:50%;background:${color};border:3px solid var(--bg);box-shadow:0 0 0 2px ${color};margin-top:14px;flex-shrink:0;${step.status === 'running' ? 'animation:pulse 1.5s ease-in-out infinite' : ''}`,
    });
    const connector = isLast ? null : h('div', {
      style: 'width:2px;flex:1;background:var(--bg4);margin-left:6px',
    });
    const rail = h('div', {
      style: 'display:flex;flex-direction:column;align-items:center;width:14px;flex-shrink:0',
    }, dot, connector);

    const card = h('div', {
      style: 'flex:1;min-width:0;background:var(--bg2);border:1px solid var(--bg4);border-radius:10px;padding:14px 16px;margin-bottom:14px',
    },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' },
        h('span', { style: 'font-size:18px;flex-shrink:0' }, icon),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'font-size:14px;font-weight:600;color:var(--fg)' }, step.title),
          h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:1px' },
            `${step.role.replace('kaggle_', '')} · step ${step.step_index + 1}`,
          ),
        ),
        h('span', {
          style: `font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.05em;flex-shrink:0`,
        }, step.status),
      ),
      step.description ? h('div', { style: 'font-size:12px;color:var(--fg2);margin:6px 0 8px;line-height:1.5' }, step.description) : null,
      h('div', { style: 'display:flex;gap:14px;font-size:11px;color:var(--fg3);flex-wrap:wrap' },
        step.started_at ? h('span', null, `Started ${fmtTime(step.started_at)}`) : null,
        step.completed_at ? h('span', null, `Finished ${fmtTime(step.completed_at)}`) : null,
        dur ? h('span', null, `Duration ${dur}`) : null,
        step.agent_id ? h('span', { style: 'font-family:var(--font-mono,monospace)' }, step.agent_id) : null,
      ),
      step.summary ? h('div', {
        style: 'font-size:12px;color:var(--fg);background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px 10px;margin-top:8px;white-space:pre-wrap',
      }, step.summary) : null,
    );

    const row = h('div', { style: 'display:flex;gap:14px;align-items:stretch' }, rail, card);
    return row;
  }

  function renderHeader(run: RunHeader) {
    headerEl.innerHTML = '';
    const color = RUN_STATUS_COLOR[run.status] ?? '#6b7280';
    statusPillEl.style.background = color;
    statusPillEl.textContent = run.status;
    headerEl.appendChild(
      h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
        h('h2', { style: 'font-size:22px;font-weight:700;color:var(--fg);margin:0' }, run.title || run.competition_ref),
        statusPillEl,
      ),
    );
    headerEl.appendChild(
      h('div', { style: 'font-size:12px;color:var(--fg3);display:flex;gap:14px;flex-wrap:wrap' },
        h('span', null, `Competition: ${run.competition_ref}`),
        run.mesh_id ? h('span', { style: 'font-family:var(--font-mono,monospace)' }, `Mesh: ${run.mesh_id}`) : null,
        h('span', null, `${run.step_count} steps`),
        h('span', null, `${run.event_count} events`),
      ),
    );
    if (run.summary) {
      headerEl.appendChild(h('div', {
        style: 'font-size:12px;color:var(--fg2);background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:8px 10px;margin-top:6px',
      }, run.summary));
    }
  }

  function renderSteps(steps: StepRow[]) {
    stepsEl.innerHTML = '';
    stepIndex.clear();
    steps.forEach((step, i) => {
      const card = buildStepCard(step, i === steps.length - 1);
      stepIndex.set(step.id, card);
      stepsEl.appendChild(card);
    });
  }

  function appendEvent(ev: EventFrame) {
    if (eventsEl.contains(emptyEventsHint)) eventsEl.removeChild(emptyEventsHint);
    const item = h('div', {
      style: 'display:flex;gap:8px;align-items:flex-start;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:8px 10px',
    },
      h('span', { style: 'font-size:14px;flex-shrink:0;margin-top:1px' }, ev.kind === 'tool_call' ? '🔧' : ev.kind === 'mesh_provisioned' ? '🧬' : ev.kind === 'status_change' ? '🔄' : ev.kind === 'step_started' ? '▶️' : '•'),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap' },
          h('span', { style: 'font-size:11px;font-weight:600;color:var(--fg2)' }, ev.kind),
          ev.agentId ? h('span', { style: 'font-size:10px;color:var(--fg3);font-family:var(--font-mono,monospace)' }, ev.agentId) : null,
          h('span', { style: 'font-size:10px;color:var(--fg3);margin-left:auto' }, fmtTime(ev.createdAt)),
        ),
        h('div', { style: 'font-size:12px;color:var(--fg);line-height:1.4' }, ev.summary),
        ev.toolKey ? h('div', { style: 'font-size:10px;color:var(--fg3);margin-top:2px' }, `tool: ${ev.toolKey}`) : null,
      ),
    );
    eventsEl.appendChild(item);
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  // ── Loaders ────────────────────────────────────────────────────────────
  async function loadRunSnapshot() {
    try {
      const res = await fetch(`/api/kaggle/competition-runs/${runId}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json() as { run: RunHeader; steps: StepRow[] };
      currentRun = data.run;
      currentSteps = data.steps;
      renderHeader(data.run);
      renderSteps(data.steps);
      if (['completed', 'abandoned', 'failed'].includes(data.run.status)) {
        cleanup();
      }
    } catch { /* ignore */ }
  }

  function startEventStream() {
    eventsES = new EventSource(`/api/kaggle/competition-runs/${runId}/events`, { withCredentials: true });
    const handler = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as EventFrame;
        appendEvent(ev);
        // Refresh step snapshot after each event so status pills stay live.
        void loadRunSnapshot();
      } catch { /* ignore */ }
    };
    // Subscribe to all kinds we emit.
    for (const kind of ['status_change', 'mesh_provisioned', 'mesh_provision_failed', 'step_started', 'step_completed', 'tool_call', 'agent_message', 'evidence', 'log', 'event']) {
      eventsES.addEventListener(kind, handler);
    }
    eventsES.addEventListener('run_status', () => { void loadRunSnapshot(); });
    eventsES.onerror = () => { /* swallow; status poll keeps UI fresh */ };
  }

  setTimeout(() => {
    void loadRunSnapshot();
    statusPoll = setInterval(() => { void loadRunSnapshot(); }, 4_000);
    startEventStream();
  }, 80);

  // ── Layout ─────────────────────────────────────────────────────────────
  const view = h('div', { className: 'dash-view' },
    h('style', null, '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}'),
    h('div', { style: 'max-width:1180px;margin:0 auto' },
      h('div', { style: 'display:flex;align-items:flex-start;gap:18px;margin-bottom:24px' },
        h('div', { style: 'flex:1;min-width:0' }, headerEl),
        h('div', { style: 'display:flex;gap:8px;flex-shrink:0' },
          h('button', {
            className: 'nav-btn',
            style: 'color:var(--danger,#dc2626)',
            onClick: () => {
              fetch(`/api/kaggle/competition-runs/${runId}/cancel`, {
                method: 'POST',
                credentials: 'include',
              }).finally(() => { void loadRunSnapshot(); });
            },
          }, 'Cancel'),
          h('button', {
            className: 'nav-btn',
            onClick: () => {
              cleanup();
              (state as any).kaggleView = 'list';
              (state as any).kaggleRunId = null;
              render();
            },
          }, '← Back'),
        ),
      ),
      h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px' },
        h('div', null,
          h('div', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:12px' }, 'Pipeline'),
          stepsEl,
        ),
        h('div', null,
          h('div', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:12px' }, 'Live Events'),
          eventsEl,
        ),
      ),
    ),
  );

  // Cleanup streams when the element is removed from DOM.
  const obs = new MutationObserver(() => {
    if (!document.body.contains(view)) {
      cleanup();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return view;
}
