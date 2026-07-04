/**
 * GeneWeave — MCP Gateway Activity UI (Phase 8)
 *
 * Read-only dashboard rendering per-client aggregate counts (last 24 h
 * by default) over `mcp_gateway_request_log` and a recent-requests feed.
 * Rendered when admin tab schema has customView = 'mcp-gateway-activity'.
 */

import { h } from './dom.js';
import { api } from './api.js';

// ── Types ────────────────────────────────────────────────────

type Outcome = 'ok' | 'rate_limited' | 'unauthorized' | 'disabled' | 'error';

interface ActivitySummary {
  client_id: string | null;
  client_name: string | null;
  total: number;
  ok: number;
  rate_limited: number;
  unauthorized: number;
  errors: number;
  last_seen: string | null;
}

interface ActivityEvent {
  id: string;
  client_id: string | null;
  client_name: string | null;
  method: string | null;
  tool_name: string | null;
  outcome: Outcome;
  status_code: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

interface ActivityState {
  loading: boolean;
  error: string | null;
  initialized: boolean;
  windowSpec: '1h' | '24h' | '7d';
  since: string | null;
  summary: ActivitySummary[];
  events: ActivityEvent[];
  filterClientId: string | null;
  filterOutcome: Outcome | null;
}

const state: ActivityState = {
  loading: false,
  error: null,
  initialized: false,
  windowSpec: '24h',
  since: null,
  summary: [],
  events: [],
  filterClientId: null,
  filterOutcome: null,
};

// ── Loading ──────────────────────────────────────────────────

async function loadAll(render: () => void): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const summaryResp = await api.get(`/api/admin/mcp-gateway-activity/summary?window=${state.windowSpec}`);
    if (!summaryResp.ok) throw new Error(`summary HTTP ${summaryResp.status}`);
    const summaryData = await summaryResp.json() as { since: string; summary: ActivitySummary[] };
    state.since = summaryData.since;
    state.summary = summaryData.summary ?? [];

    const recentParams = new URLSearchParams();
    recentParams.set('limit', '100');
    if (state.filterClientId) recentParams.set('client_id', state.filterClientId);
    if (state.filterOutcome) recentParams.set('outcome', state.filterOutcome);
    const eventsResp = await api.get(`/api/admin/mcp-gateway-activity/recent?${recentParams.toString()}`);
    if (!eventsResp.ok) throw new Error(`recent HTTP ${eventsResp.status}`);
    const eventsData = await eventsResp.json() as { events: ActivityEvent[] };
    state.events = eventsData.events ?? [];
  } catch (err) {
    state.error = `Failed to load activity: ${(err as Error).message}`;
  }
  state.loading = false;
  state.initialized = true;
  render();
}

// ── Helpers ──────────────────────────────────────────────────

function fmtTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const OUTCOME_COLORS: Record<Outcome, string> = {
  ok: '#2e7d32',
  rate_limited: '#ef6c00',
  unauthorized: '#c62828',
  disabled: '#757575',
  error: '#c62828',
};

function outcomeBadge(outcome: Outcome): HTMLElement {
  const color = OUTCOME_COLORS[outcome];
  return h('span', {
    style: `display:inline-block;padding:2px 8px;font-size:11px;font-weight:600;color:#fff;background:${color};border-radius:3px;text-transform:uppercase;`,
  }, outcome.replace('_', ' '));
}

// ── Renderers ────────────────────────────────────────────────

function renderSummary(render: () => void): HTMLElement {
  const card = h('div', { style: 'background:var(--bg2,#fafafa);border:1px solid var(--border,#ddd);border-radius:6px;padding:12px;margin-bottom:16px;' });

  card.appendChild(
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;' },
      h('h4', { style: 'margin:0;font-size:13px;font-weight:600;' }, 'Per-client activity'),
      h('span', { style: 'flex:1;' }),
      ...(['1h', '24h', '7d'] as const).map((win) =>
        h('button', {
          className: 'nav-btn',
          style: `font-size:11px;padding:3px 10px;${state.windowSpec === win ? 'background:var(--accent,#0078d4);color:#fff;' : ''}`,
          onClick: () => {
            state.windowSpec = win;
            void loadAll(render);
          },
        }, win),
      ),
    ),
  );

  if (state.summary.length === 0) {
    card.appendChild(h('div', { style: 'padding:18px;text-align:center;color:var(--fg2);font-size:12px;' }, 'No gateway activity in this window.'));
    return card;
  }

  const table = h('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;' });
  const head = h('thead', {});
  head.appendChild(
    h('tr', { style: 'background:var(--bg3,#f0f0f0);text-align:left;' },
      h('th', { style: 'padding:6px 8px;' }, 'Client'),
      h('th', { style: 'padding:6px 8px;text-align:right;' }, 'Total'),
      h('th', { style: 'padding:6px 8px;text-align:right;color:#2e7d32;' }, 'OK'),
      h('th', { style: 'padding:6px 8px;text-align:right;color:#ef6c00;' }, '429'),
      h('th', { style: 'padding:6px 8px;text-align:right;color:#c62828;' }, '401'),
      h('th', { style: 'padding:6px 8px;text-align:right;color:#c62828;' }, 'Errors'),
      h('th', { style: 'padding:6px 8px;' }, 'Last seen'),
      h('th', { style: 'padding:6px 8px;' }, ''),
    ),
  );
  table.appendChild(head);

  const tbody = h('tbody', {});
  for (const row of state.summary) {
    const tr = h('tr', {
      style: `border-top:1px solid var(--border,#e0e0e0);${state.filterClientId === row.client_id ? 'background:var(--bg3,#eaf3ff);' : ''}`,
    });
    tr.appendChild(h('td', { style: 'padding:6px 8px;font-weight:600;' }, row.client_name ?? (row.client_id ? row.client_id.slice(0, 8) : '<unauthorized>')));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;' }, String(row.total)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;' }, String(row.ok)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;' }, String(row.rate_limited)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;' }, String(row.unauthorized)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;' }, String(row.errors)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;color:var(--fg2);' }, fmtTimestamp(row.last_seen)));
    tr.appendChild(
      h('td', { style: 'padding:6px 8px;text-align:right;' },
        h('button', {
          className: 'nav-btn',
          style: 'font-size:11px;padding:3px 8px;',
          onClick: () => {
            state.filterClientId = state.filterClientId === row.client_id ? null : row.client_id;
            void loadAll(render);
          },
        }, state.filterClientId === row.client_id ? 'Clear filter' : 'Filter recent'),
      ),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

function renderRecent(render: () => void): HTMLElement {
  const card = h('div', { style: 'background:var(--bg2,#fafafa);border:1px solid var(--border,#ddd);border-radius:6px;padding:12px;' });

  const header = h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;' },
    h('h4', { style: 'margin:0;font-size:13px;font-weight:600;' }, 'Recent requests'),
    h('span', { style: 'flex:1;' }),
  );

  // Outcome filter buttons
  const outcomes: (Outcome | null)[] = [null, 'ok', 'rate_limited', 'unauthorized', 'error'];
  for (const o of outcomes) {
    header.appendChild(
      h('button', {
        className: 'nav-btn',
        style: `font-size:11px;padding:3px 10px;${state.filterOutcome === o ? 'background:var(--accent,#0078d4);color:#fff;' : ''}`,
        onClick: () => {
          state.filterOutcome = o;
          void loadAll(render);
        },
      }, o == null ? 'all' : o.replace('_', ' ')),
    );
  }

  card.appendChild(header);

  if (state.filterClientId) {
    const matched = state.summary.find((s) => s.client_id === state.filterClientId);
    card.appendChild(
      h('div', {
        style: 'margin-bottom:8px;padding:6px 10px;background:var(--bg3,#eaf3ff);border-radius:4px;font-size:11px;color:var(--fg2);',
      }, `Filtered to client: ${matched?.client_name ?? state.filterClientId}. `,
        h('a', {
          href: '#',
          style: 'color:var(--accent,#0078d4);',
          onClick: (e: Event) => { e.preventDefault(); state.filterClientId = null; void loadAll(render); },
        }, 'clear'),
      ),
    );
  }

  if (state.events.length === 0) {
    card.appendChild(h('div', { style: 'padding:18px;text-align:center;color:var(--fg2);font-size:12px;' }, 'No matching events.'));
    return card;
  }

  const table = h('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;' });
  const head = h('thead', {});
  head.appendChild(
    h('tr', { style: 'background:var(--bg3,#f0f0f0);text-align:left;' },
      h('th', { style: 'padding:6px 8px;' }, 'Time'),
      h('th', { style: 'padding:6px 8px;' }, 'Client'),
      h('th', { style: 'padding:6px 8px;' }, 'Method'),
      h('th', { style: 'padding:6px 8px;' }, 'Tool'),
      h('th', { style: 'padding:6px 8px;' }, 'Outcome'),
      h('th', { style: 'padding:6px 8px;text-align:right;' }, 'Status'),
      h('th', { style: 'padding:6px 8px;text-align:right;' }, 'Duration'),
    ),
  );
  table.appendChild(head);

  const tbody = h('tbody', {});
  for (const ev of state.events) {
    const tr = h('tr', { style: 'border-top:1px solid var(--border,#e0e0e0);' });
    tr.appendChild(h('td', { style: 'padding:6px 8px;color:var(--fg2);white-space:nowrap;' }, fmtTimestamp(ev.created_at)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;' }, ev.client_name ?? '<unauthorized>'));
    tr.appendChild(h('td', { style: 'padding:6px 8px;font-family:monospace;font-size:11px;' }, ev.method ?? '—'));
    tr.appendChild(h('td', { style: 'padding:6px 8px;font-family:monospace;font-size:11px;' }, ev.tool_name ?? '—'));
    tr.appendChild(h('td', { style: 'padding:6px 8px;' }, outcomeBadge(ev.outcome)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;font-family:monospace;' }, String(ev.status_code)));
    tr.appendChild(h('td', { style: 'padding:6px 8px;text-align:right;color:var(--fg2);' }, fmtDuration(ev.duration_ms)));
    tbody.appendChild(tr);
    if (ev.error_message) {
      const errRow = h('tr', {});
      errRow.appendChild(h('td', { colSpan: 7, style: 'padding:0 8px 6px 8px;font-size:11px;color:#c62828;font-family:monospace;' }, `↳ ${ev.error_message}`));
      tbody.appendChild(errRow);
    }
  }
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

// ── Top-level view ───────────────────────────────────────────

export function renderMCPGatewayActivityView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  if (!state.initialized && !state.loading) {
    void loadAll(render);
  }

  const container = h('div', { style: 'max-width:1100px;', 'data-testid': 'mcp-gateway-activity-view' });

  container.appendChild(
    h('div', { style: 'margin-bottom:16px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'MCP Gateway Activity'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Append-only audit of every gateway request: tools/list, tools/call, denied auth, rate-limit 429s, and errors. Use this to verify bearer-token isolation, spot misbehaving clients, and confirm rate limits are taking effect.',
      ),
    ),
  );

  // Toolbar
  container.appendChild(
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;' },
      h('span', { style: 'font-size:11px;color:var(--fg2);' }, state.since ? `Since ${fmtTimestamp(state.since)}` : ''),
      h('span', { style: 'flex:1;' }),
      h('button', {
        className: 'nav-btn',
        style: 'font-size:11px;padding:4px 10px;',
        onClick: () => void loadAll(render),
      }, '↻ Refresh'),
    ),
  );

  if (state.error) {
    container.appendChild(h('div', { style: 'padding:16px;color:#c62828;background:#fce8e6;border-radius:6px;font-size:13px;' }, state.error));
    return container;
  }

  if (state.loading && !state.initialized) {
    container.appendChild(h('div', { style: 'padding:32px;text-align:center;color:var(--fg2);font-size:13px;' }, 'Loading…'));
    return container;
  }

  container.appendChild(renderSummary(render));
  container.appendChild(renderRecent(render));

  return container;
}
