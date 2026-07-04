/**
 * GeneWeave — Tool Approval Requests UI (Phase 6)
 *
 * Custom admin view for reviewing and actioning pending tool approval requests.
 * Rendered when admin tab schema has customView = 'tool-approval-requests'.
 *
 * Features:
 *   - Status filter tabs: All / Pending / Approved / Denied
 *   - Per-request detail: tool name, skill key, policy, input preview, timestamps
 *   - Approve / Deny action buttons with optional resolution note
 *   - Live refresh after each action
 */

import { h } from './dom.js';
import { api } from './api.js';

interface ApprovalRequest {
  id: string;
  tool_name: string;
  chat_id: string;
  skill_key: string | null;
  policy_key: string | null;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  input_preview: string | null;
}

interface ApprovalState {
  requests: ApprovalRequest[];
  loading: boolean;
  error: string | null;
  initialized: boolean;
  statusFilter: 'all' | 'pending' | 'approved' | 'denied';
  expandedId: string | null;
  acting: Record<string, boolean>;    // requestId → true while approve/deny in flight
  noteInputs: Record<string, string>; // requestId → current note text
  actionError: Record<string, string>;
}

const approvalState: ApprovalState = {
  requests: [],
  loading: false,
  error: null,
  initialized: false,
  statusFilter: 'pending',
  expandedId: null,
  acting: {},
  noteInputs: {},
  actionError: {},
};

async function loadApprovalRequests(render: () => void): Promise<void> {
  approvalState.loading = true;
  approvalState.error = null;
  render();
  try {
    const status = approvalState.statusFilter === 'all' ? undefined : approvalState.statusFilter;
    const url = status
      ? `/api/admin/tool-approval-requests?status=${status}&limit=100`
      : `/api/admin/tool-approval-requests?limit=100`;
    const resp = await api.get(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { requests: ApprovalRequest[] };
    approvalState.requests = data.requests ?? [];
  } catch (err) {
    approvalState.error = `Failed to load requests: ${(err as Error).message}`;
  }
  approvalState.loading = false;
  approvalState.initialized = true;
  render();
}

async function actOnRequest(
  id: string,
  action: 'approve' | 'deny',
  render: () => void,
): Promise<void> {
  approvalState.acting[id] = true;
  approvalState.actionError[id] = '';
  render();
  try {
    const note = approvalState.noteInputs[id] ?? '';
    const resp = await api.post(`/api/admin/tool-approval-requests/${id}/${action}`, note ? { note } : {});
    if (!resp.ok) {
      const body = await resp.json() as { error?: string };
      throw new Error(body.error ?? `HTTP ${resp.status}`);
    }
    // Update the row in-place without full reload
    const updated = await resp.json() as { request: ApprovalRequest };
    const idx = approvalState.requests.findIndex(r => r.id === id);
    if (idx !== -1) approvalState.requests[idx] = updated.request;
    approvalState.noteInputs[id] = '';
    approvalState.expandedId = null;
  } catch (err) {
    approvalState.actionError[id] = (err as Error).message;
  }
  approvalState.acting[id] = false;
  render();
}

function statusBadge(status: ApprovalRequest['status']): HTMLElement {
  const colors: Record<string, string> = {
    pending: '#e65100',
    approved: '#1e7e34',
    denied: '#c62828',
  };
  const bgColors: Record<string, string> = {
    pending: '#fff3e0',
    approved: '#e6f4ea',
    denied: '#fce8e6',
  };
  return h('span', {
    style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;`
      + `color:${colors[status] ?? 'var(--fg2)'};background:${bgColors[status] ?? 'var(--bg2)'};`,
  }, status.toUpperCase());
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function renderRequestCard(req: ApprovalRequest, render: () => void): HTMLElement {
  const isExpanded = approvalState.expandedId === req.id;
  const isActing = !!approvalState.acting[req.id];
  const actErr = approvalState.actionError[req.id] ?? '';
  const isPending = req.status === 'pending';

  const card = h('div', {
    className: `approval-card approval-card--${req.status}`,
    style: `border:1px solid var(--border1);border-radius:6px;margin-bottom:8px;overflow:hidden;`,
  });

  // Card header row (always visible)
  const header = h('div', {
    style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;'
      + 'background:var(--bg2);user-select:none;',
    onClick: () => {
      approvalState.expandedId = isExpanded ? null : req.id;
      render();
    },
  },
    // Chevron
    h('span', { style: `font-size:11px;color:var(--fg3);transition:transform 0.15s;transform:rotate(${isExpanded ? '90' : '0'}deg)` }, '▶'),
    // Tool name
    h('span', { style: 'font-weight:600;font-size:13px;color:var(--fg1);flex:1;' }, req.tool_name),
    // Skill badge
    req.skill_key
      ? h('span', { style: 'font-size:11px;color:var(--fg2);background:var(--bg3,#f0f0f0);padding:2px 6px;border-radius:4px;' },
          `skill: ${req.skill_key}`)
      : null!,
    // Status badge
    statusBadge(req.status),
    // Requested at
    h('span', { style: 'font-size:11px;color:var(--fg3);white-space:nowrap;' }, formatDate(req.requested_at)),
    // Quick approve/deny inline for pending (visible without expanding)
    isPending
      ? h('div', {
          style: 'display:flex;gap:6px;margin-left:8px;',
          onClick: (e: MouseEvent) => e.stopPropagation(),
        },
          h('button', {
            className: 'nav-btn',
            disabled: isActing,
            style: 'font-size:11px;padding:3px 10px;background:#1e7e34;color:#fff;border:none;border-radius:4px;cursor:pointer;',
            onClick: (e: MouseEvent) => { e.stopPropagation(); void actOnRequest(req.id, 'approve', render); },
          }, isActing ? '…' : '✓ Approve'),
          h('button', {
            className: 'nav-btn',
            disabled: isActing,
            style: 'font-size:11px;padding:3px 10px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;',
            onClick: (e: MouseEvent) => { e.stopPropagation(); void actOnRequest(req.id, 'deny', render); },
          }, isActing ? '…' : '✗ Deny'),
        )
      : null!,
  );
  card.appendChild(header);

  // Expanded detail panel
  if (isExpanded) {
    const detail = h('div', {
      style: 'padding:14px;border-top:1px solid var(--border1);background:var(--bg1);',
    });

    // Metadata grid
    const meta: Array<[string, string]> = [
      ['Request ID', req.id],
      ['Chat ID', req.chat_id || '—'],
      ['Policy Key', req.policy_key || '—'],
      ['Skill Key', req.skill_key || '—'],
    ];
    if (req.resolved_at) {
      meta.push(['Resolved At', formatDate(req.resolved_at)]);
      meta.push(['Resolved By', req.resolved_by || '—']);
    }
    if (req.resolution_note) {
      meta.push(['Note', req.resolution_note]);
    }

    detail.appendChild(
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin-bottom:12px;' },
        ...meta.map(([label, value]) =>
          h('div', { style: 'font-size:12px;padding:3px 0;border-bottom:1px solid var(--border1);' },
            h('span', { style: 'color:var(--fg2);' }, label + ': '),
            h('span', { style: 'color:var(--fg1);font-weight:500;word-break:break-all;' }, value)
          )
        )
      )
    );

    // Input preview
    if (req.input_preview) {
      detail.appendChild(h('div', { style: 'margin-bottom:12px;' },
        h('div', { style: 'font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Input Preview'),
        h('pre', {
          style: 'font-size:11px;background:var(--bg3,#f5f5f5);padding:8px;border-radius:4px;'
            + 'overflow:auto;max-height:120px;margin:0;white-space:pre-wrap;word-break:break-all;',
        }, req.input_preview)
      ));
    }

    // Approve/Deny with note (expanded section, only for pending)
    if (isPending) {
      const noteInput = h('input', {
        type: 'text',
        placeholder: 'Optional resolution note…',
        value: approvalState.noteInputs[req.id] ?? '',
        style: 'width:100%;box-sizing:border-box;padding:6px 8px;font-size:12px;'
          + 'border:1px solid var(--border1);border-radius:4px;background:var(--bg2);color:var(--fg1);margin-bottom:8px;',
        onInput: (e: Event) => {
          approvalState.noteInputs[req.id] = (e.target as HTMLInputElement).value;
        },
      }) as HTMLInputElement;
      detail.appendChild(noteInput);

      detail.appendChild(
        h('div', { style: 'display:flex;gap:8px;' },
          h('button', {
            className: 'nav-btn',
            disabled: isActing,
            'data-testid': `approve-btn-${req.id}`,
            style: 'padding:6px 16px;background:#1e7e34;color:#fff;border:none;border-radius:4px;'
              + 'cursor:pointer;font-size:12px;font-weight:600;',
            onClick: () => void actOnRequest(req.id, 'approve', render),
          }, isActing ? 'Processing…' : '✓ Approve'),
          h('button', {
            className: 'nav-btn',
            disabled: isActing,
            'data-testid': `deny-btn-${req.id}`,
            style: 'padding:6px 16px;background:#c62828;color:#fff;border:none;border-radius:4px;'
              + 'cursor:pointer;font-size:12px;font-weight:600;',
            onClick: () => void actOnRequest(req.id, 'deny', render),
          }, isActing ? 'Processing…' : '✗ Deny'),
        )
      );

      if (actErr) {
        detail.appendChild(
          h('div', { style: 'margin-top:6px;font-size:12px;color:#c62828;' }, actErr)
        );
      }
    }

    card.appendChild(detail);
  }

  return card;
}

export function renderToolApprovalView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  // Load on first mount (once only — avoid infinite re-render loop when requests list is empty)
  if (!approvalState.initialized && !approvalState.loading) {
    void loadApprovalRequests(render);
  }

  const container = h('div', { className: 'approval-container', style: 'max-width:900px;' });

  // Header
  container.appendChild(
    h('div', { style: 'margin-bottom:16px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'Tool Approval Requests'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Review and action pending tool invocation approvals. Approved requests resume the blocked agent turn; denied requests reject the tool call.'
      )
    )
  );

  // Status filter tabs + refresh button
  const filterBar = h('div', { style: 'display:flex;align-items:center;gap:4px;margin-bottom:16px;' });
  const statusOptions: Array<ApprovalState['statusFilter']> = ['pending', 'all', 'approved', 'denied'];
  for (const s of statusOptions) {
    const isActive = approvalState.statusFilter === s;
    filterBar.appendChild(
      h('button', {
        style: `padding:4px 12px;border-radius:4px;font-size:12px;cursor:pointer;border:1px solid var(--border1);`
          + (isActive
            ? 'background:var(--accent,#0078d4);color:#fff;font-weight:600;'
            : 'background:var(--bg2);color:var(--fg2);'),
        onClick: () => {
          approvalState.statusFilter = s;
          approvalState.requests = [];
          void loadApprovalRequests(render);
        },
      }, s.charAt(0).toUpperCase() + s.slice(1))
    );
  }
  // spacer + refresh
  filterBar.appendChild(h('span', { style: 'flex:1;' }));
  filterBar.appendChild(
    h('button', {
      className: 'nav-btn',
      style: 'font-size:11px;padding:4px 10px;',
      onClick: () => void loadApprovalRequests(render),
    }, '↻ Refresh')
  );
  container.appendChild(filterBar);

  // Error state
  if (approvalState.error) {
    container.appendChild(
      h('div', { style: 'padding:16px;color:#c62828;background:#fce8e6;border-radius:6px;font-size:13px;' },
        approvalState.error)
    );
    return container;
  }

  // Loading state
  if (approvalState.loading) {
    container.appendChild(
      h('div', { style: 'padding:32px;text-align:center;color:var(--fg2);font-size:13px;' }, 'Loading…')
    );
    return container;
  }

  // Empty state
  if (approvalState.requests.length === 0) {
    const label = approvalState.statusFilter === 'pending' ? 'pending' : approvalState.statusFilter;
    container.appendChild(
      h('div', {
        className: 'approval-empty',
        style: 'padding:40px;text-align:center;color:var(--fg2);font-size:13px;'
          + 'border:1px dashed var(--border1);border-radius:6px;',
      },
        h('div', { style: 'font-size:32px;margin-bottom:8px;' }, '✓'),
        h('div', { style: 'font-weight:600;margin-bottom:4px;' }, `No ${label} approval requests`),
        h('div', { style: 'font-size:12px;' },
          label === 'pending'
            ? 'Requests appear here when an agent tries to use a policy-gated tool that requires approval.'
            : 'No requests match this filter.'
        )
      )
    );
    return container;
  }

  // Request list
  const pendingCount = approvalState.requests.filter(r => r.status === 'pending').length;
  container.appendChild(
    h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:10px;' },
      `${approvalState.requests.length} request${approvalState.requests.length !== 1 ? 's' : ''}`,
      pendingCount > 0 ? ` — ${pendingCount} pending` : ''
    )
  );

  for (const req of approvalState.requests) {
    container.appendChild(renderRequestCard(req, render));
  }

  return container;
}
