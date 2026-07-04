/**
 * GeneWeave — MCP Gateway Clients UI (Phase 6)
 *
 * Custom admin view for managing per-client MCP gateway bearer tokens.
 * Rendered when admin tab schema has customView = 'mcp-gateway-clients'.
 *
 * Distinct from generic admin CRUD because:
 *   - Plaintext bearer tokens are returned exactly once on create/rotate
 *     and must be surfaced in a copy-once banner that does not persist.
 *   - Revoke is a soft-delete action (preserves audit trail) and lives
 *     alongside hard delete, so we render both as explicit buttons.
 *   - allowed_classes is a multi-select of allocation classes and benefits
 *     from a checkbox UI rather than free-form JSON.
 */

import { h } from './dom.js';
import { api } from './api.js';
import { noticeDialog, confirmDialog } from "./dialog.js";

// ── Types ────────────────────────────────────────────────────

interface GatewayClient {
  id: string;
  name: string;
  description: string | null;
  token_hash: string;
  allowed_classes: string | null;
  audit_chat_id: string | null;
  enabled: 0 | 1;
  last_used_at: string | null;
  revoked_at: string | null;
  rate_limit_per_minute: number | null;
  // Phase 9: optional token lifetime + last rotation marker.
  expires_at: string | null;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ClientsState {
  clients: GatewayClient[];
  loading: boolean;
  error: string | null;
  initialized: boolean;
  // Plaintext token revealed exactly once after create/rotate. Cleared
  // when the operator dismisses the banner.
  revealedToken: { clientId: string; clientName: string; token: string; reason: 'created' | 'rotated' } | null;
  showCreateForm: boolean;
  createForm: { name: string; description: string; auditChatId: string; allowedClasses: Set<string>; rateLimitPerMinute: string; expiresInDays: string };
  createError: string | null;
  acting: Record<string, 'rotating' | 'revoking' | 'deleting' | null>;
  actionError: Record<string, string>;
}

// Allocation classes operators can scope a client to. Mirrors the gateway
// runtime's allocationClass values; an empty selection means "inherit
// gateway defaults" (allowed_classes stored as null).
const ALLOCATION_CLASSES = ['web', 'data', 'enterprise', 'social', 'communication', 'utility'] as const;

const clientsState: ClientsState = {
  clients: [],
  loading: false,
  error: null,
  initialized: false,
  revealedToken: null,
  showCreateForm: false,
  createForm: { name: '', description: '', auditChatId: '', allowedClasses: new Set(), rateLimitPerMinute: '', expiresInDays: '' },
  createError: null,
  acting: {},
  actionError: {},
};

// ── Data loading ─────────────────────────────────────────────

async function loadClients(render: () => void): Promise<void> {
  clientsState.loading = true;
  clientsState.error = null;
  render();
  try {
    const resp = await api.get('/api/admin/mcp-gateway-clients');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { clients: GatewayClient[] };
    clientsState.clients = data.clients ?? [];
  } catch (err) {
    clientsState.error = `Failed to load clients: ${(err as Error).message}`;
  }
  clientsState.loading = false;
  clientsState.initialized = true;
  render();
}

async function createClient(render: () => void): Promise<void> {
  clientsState.createError = null;
  const { name, description, auditChatId, allowedClasses, rateLimitPerMinute, expiresInDays } = clientsState.createForm;
  if (!name.trim()) {
    clientsState.createError = 'Name is required';
    render();
    return;
  }
  let parsedRate: number | null = null;
  if (rateLimitPerMinute.trim()) {
    const n = Number(rateLimitPerMinute);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      clientsState.createError = 'Rate limit must be a positive whole number or empty';
      render();
      return;
    }
    parsedRate = n;
  }
  let parsedExpiryDays: number | null = null;
  if (expiresInDays.trim()) {
    const n = Number(expiresInDays);
    if (!Number.isFinite(n) || n <= 0) {
      clientsState.createError = 'Expires in days must be a positive number or empty';
      render();
      return;
    }
    parsedExpiryDays = n;
  }
  try {
    const body: Record<string, unknown> = { name: name.trim() };
    if (description.trim()) body['description'] = description.trim();
    if (auditChatId.trim()) body['audit_chat_id'] = auditChatId.trim();
    if (allowedClasses.size > 0) body['allowed_classes'] = [...allowedClasses];
    if (parsedRate !== null) body['rate_limit_per_minute'] = parsedRate;
    // Server accepts numeric "days from now" as a shortcut for expires_at.
    if (parsedExpiryDays !== null) body['expires_at'] = parsedExpiryDays;
    const resp = await api.post('/api/admin/mcp-gateway-clients', body);
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(e.error ?? `HTTP ${resp.status}`);
    }
    const data = await resp.json() as { client: GatewayClient; token: string };
    clientsState.revealedToken = {
      clientId: data.client.id,
      clientName: data.client.name,
      token: data.token,
      reason: 'created',
    };
    clientsState.showCreateForm = false;
    clientsState.createForm = { name: '', description: '', auditChatId: '', allowedClasses: new Set(), rateLimitPerMinute: '', expiresInDays: '' };
    await loadClients(render);
  } catch (err) {
    clientsState.createError = (err as Error).message;
    render();
  }
}

async function rotateClient(client: GatewayClient, render: () => void): Promise<void> {
  if (!(await confirmDialog({ message: `Rotate the bearer token for "${client.name}"? The current token will stop working immediately.`, danger: true }))) return;
  clientsState.acting[client.id] = 'rotating';
  clientsState.actionError[client.id] = '';
  render();
  try {
    const resp = await api.post(`/api/admin/mcp-gateway-clients/${client.id}/rotate`, {});
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(e.error ?? `HTTP ${resp.status}`);
    }
    const data = await resp.json() as { client: GatewayClient; token: string };
    clientsState.revealedToken = {
      clientId: data.client.id,
      clientName: data.client.name,
      token: data.token,
      reason: 'rotated',
    };
    await loadClients(render);
  } catch (err) {
    clientsState.actionError[client.id] = (err as Error).message;
  }
  clientsState.acting[client.id] = null;
  render();
}

async function revokeClient(client: GatewayClient, render: () => void): Promise<void> {
  if (!(await confirmDialog({ message: `Revoke client "${client.name}"? It will be soft-disabled but kept for audit history.`, danger: true }))) return;
  clientsState.acting[client.id] = 'revoking';
  render();
  try {
    const resp = await api.post(`/api/admin/mcp-gateway-clients/${client.id}/revoke`, {});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await loadClients(render);
  } catch (err) {
    clientsState.actionError[client.id] = (err as Error).message;
  }
  clientsState.acting[client.id] = null;
  render();
}

async function deleteClient(client: GatewayClient, render: () => void): Promise<void> {
  if (!(await confirmDialog({ message: `Permanently delete client "${client.name}"? This removes the row entirely.`, danger: true }))) return;
  clientsState.acting[client.id] = 'deleting';
  render();
  try {
    const resp = await api.del(`/api/admin/mcp-gateway-clients/${client.id}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await loadClients(render);
  } catch (err) {
    clientsState.actionError[client.id] = (err as Error).message;
  }
  clientsState.acting[client.id] = null;
  render();
}

// ── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function parseAllowed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function statusBadge(c: GatewayClient): HTMLElement {
  const isRevoked = c.revoked_at != null;
  const isEnabled = c.enabled === 1 && !isRevoked;
  const text = isRevoked ? 'REVOKED' : isEnabled ? 'ACTIVE' : 'DISABLED';
  const fg = isRevoked ? '#c62828' : isEnabled ? '#1e7e34' : '#e65100';
  const bg = isRevoked ? '#fce8e6' : isEnabled ? '#e6f4ea' : '#fff3e0';
  return h('span', {
    style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:${fg};background:${bg};`,
  }, text);
}

/** Phase 9: classify the remaining lifetime of a token's expires_at into
 *  a coarse bucket the operator can scan at a glance.
 *    expired (already past) → red
 *    expiring (<= 7 days)   → orange
 *    healthy (> 7 days)     → green
 *    none (no expires_at)   → returns null (no badge rendered) */
function expiryBadge(c: GatewayClient): HTMLElement | null {
  if (!c.expires_at) return null;
  const ms = Date.parse(c.expires_at);
  if (!Number.isFinite(ms)) return null;
  const remainingMs = ms - Date.now();
  const remainingDays = Math.ceil(remainingMs / 86_400_000);
  let text: string;
  let fg: string;
  let bg: string;
  let testid: string;
  if (remainingMs <= 0) {
    text = 'EXPIRED';
    fg = '#c62828'; bg = '#fce8e6';
    testid = 'gateway-expiry-badge-expired';
  } else if (remainingMs <= 7 * 86_400_000) {
    text = `EXPIRES IN ${remainingDays}D`;
    fg = '#e65100'; bg = '#fff3e0';
    testid = 'gateway-expiry-badge-soon';
  } else {
    text = `${remainingDays}D LEFT`;
    fg = '#1e7e34'; bg = '#e6f4ea';
    testid = 'gateway-expiry-badge-ok';
  }
  return h('span', {
    'data-testid': testid,
    style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:${fg};background:${bg};`,
  }, text);
}

// ── Token reveal banner ──────────────────────────────────────

function renderTokenBanner(render: () => void): HTMLElement | null {
  const reveal = clientsState.revealedToken;
  if (!reveal) return null;
  return h('div', {
    style: 'padding:14px;margin-bottom:16px;border:2px solid #e65100;border-radius:6px;background:#fff8e1;',
  },
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px;' },
      h('span', { style: 'font-size:18px;' }, '⚠'),
      h('div', { style: 'flex:1;' },
        h('div', { style: 'font-weight:700;font-size:13px;color:#e65100;' },
          `Bearer token ${reveal.reason} for "${reveal.clientName}"`),
        h('div', { style: 'font-size:11px;color:var(--fg2);margin-top:2px;' },
          'Copy this now — it is shown only once and cannot be retrieved later.'),
      ),
      h('button', {
        className: 'nav-btn',
        style: 'font-size:11px;padding:4px 10px;',
        onClick: () => { clientsState.revealedToken = null; render(); },
      }, 'Dismiss'),
    ),
    h('div', { style: 'display:flex;gap:8px;align-items:stretch;' },
      h('input', {
        type: 'text',
        readOnly: true,
        value: reveal.token,
        'data-testid': 'gateway-token-reveal',
        style: 'flex:1;padding:8px 10px;font-family:monospace;font-size:12px;border:1px solid var(--border1);border-radius:4px;background:var(--bg1);color:var(--fg1);',
        onClick: (e: MouseEvent) => (e.target as HTMLInputElement).select(),
      }),
      h('button', {
        className: 'nav-btn',
        style: 'padding:8px 14px;font-size:12px;font-weight:600;background:#e65100;color:#fff;border:none;border-radius:4px;cursor:pointer;',
        onClick: async () => {
          try { await navigator.clipboard.writeText(reveal.token); } catch { /* clipboard may be unavailable */ }
        },
      }, 'Copy'),
    ),
  );
}

// ── Create form ──────────────────────────────────────────────

function renderCreateForm(render: () => void): HTMLElement {
  const f = clientsState.createForm;
  const wrap = h('div', {
    style: 'padding:16px;margin-bottom:16px;border:1px solid var(--border1);border-radius:6px;background:var(--bg2);',
  });

  wrap.appendChild(h('h4', { style: 'margin:0 0 12px;font-size:14px;' }, 'New gateway client'));

  function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
    return h('div', { style: 'margin-bottom:10px;' },
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, label),
      input,
      hint ? h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:3px;' }, hint) : null!,
    );
  }

  const inputStyle = 'width:100%;box-sizing:border-box;padding:6px 8px;font-size:12px;border:1px solid var(--border1);border-radius:4px;background:var(--bg1);color:var(--fg1);';

  wrap.appendChild(field('Client name', h('input', {
    type: 'text', value: f.name, placeholder: 'e.g. claude-desktop, ci-runner',
    'data-testid': 'gateway-client-name',
    style: inputStyle,
    onInput: (e: Event) => { f.name = (e.target as HTMLInputElement).value; },
  }), 'Used as audit chatId fallback (mcp-gateway:<name>)'));

  wrap.appendChild(field('Description (optional)', h('input', {
    type: 'text', value: f.description,
    style: inputStyle,
    onInput: (e: Event) => { f.description = (e.target as HTMLInputElement).value; },
  })));

  wrap.appendChild(field('Audit chat ID override (optional)', h('input', {
    type: 'text', value: f.auditChatId, placeholder: 'tenant-acme:ci',
    style: inputStyle,
    onInput: (e: Event) => { f.auditChatId = (e.target as HTMLInputElement).value; },
  }), 'Stamps this exact chatId on every audit event from this client'));

  // Allowed classes multi-select
  const classRow = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;' });
  for (const cls of ALLOCATION_CLASSES) {
    const checked = f.allowedClasses.has(cls);
    classRow.appendChild(
      h('label', {
        style: `display:flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--border1);border-radius:14px;cursor:pointer;font-size:12px;`
          + (checked ? 'background:var(--accent,#0078d4);color:#fff;border-color:var(--accent,#0078d4);' : 'background:var(--bg1);color:var(--fg1);'),
      },
        h('input', {
          type: 'checkbox', checked,
          style: 'margin:0;',
          onChange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) f.allowedClasses.add(cls);
            else f.allowedClasses.delete(cls);
            render();
          },
        }),
        cls,
      ),
    );
  }
  wrap.appendChild(field('Allowed allocation classes', classRow, 'Empty = inherit gateway-wide defaults; otherwise restrict to selected'));

  wrap.appendChild(field('Rate limit (requests / minute, optional)', h('input', {
    type: 'number', min: '1', step: '1', value: f.rateLimitPerMinute,
    placeholder: 'e.g. 60',
    'data-testid': 'gateway-client-rate-limit',
    style: inputStyle,
    onInput: (e: Event) => { f.rateLimitPerMinute = (e.target as HTMLInputElement).value; },
  }), 'Empty = no per-client cap. Tumbling 1-minute windows. Exceeding returns HTTP 429 with Retry-After.'));

  wrap.appendChild(field('Expires in N days (optional)', h('input', {
    type: 'number', min: '1', step: '1', value: f.expiresInDays,
    placeholder: 'e.g. 30, 90',
    'data-testid': 'gateway-client-expires-in-days',
    style: inputStyle,
    onInput: (e: Event) => { f.expiresInDays = (e.target as HTMLInputElement).value; },
  }), 'Empty = no expiry. Tokens past this date are rejected with HTTP 401 and audit outcome "expired". Use Rotate to extend.'));

  if (clientsState.createError) {
    wrap.appendChild(h('div', { style: 'padding:8px;margin-bottom:10px;color:#c62828;background:#fce8e6;border-radius:4px;font-size:12px;' }, clientsState.createError));
  }

  wrap.appendChild(h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
    h('button', {
      className: 'nav-btn',
      style: 'padding:6px 14px;font-size:12px;',
      onClick: () => { clientsState.showCreateForm = false; clientsState.createError = null; render(); },
    }, 'Cancel'),
    h('button', {
      className: 'nav-btn',
      'data-testid': 'gateway-create-submit',
      style: 'padding:6px 14px;font-size:12px;font-weight:600;background:var(--accent,#0078d4);color:#fff;border:none;border-radius:4px;cursor:pointer;',
      onClick: () => void createClient(render),
    }, 'Create & mint token'),
  ));

  return wrap;
}

// ── Client row ───────────────────────────────────────────────

function renderClientRow(c: GatewayClient, render: () => void): HTMLElement {
  const acting = clientsState.acting[c.id];
  const err = clientsState.actionError[c.id] ?? '';
  const allowed = parseAllowed(c.allowed_classes);
  const isRevoked = c.revoked_at != null;

  const card = h('div', {
    style: 'border:1px solid var(--border1);border-radius:6px;margin-bottom:8px;padding:12px 14px;background:var(--bg1);'
      + (isRevoked ? 'opacity:0.7;' : ''),
  });

  card.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;' },
    h('span', { style: 'font-weight:600;font-size:13px;color:var(--fg1);flex:1;' }, c.name),
    statusBadge(c),
    expiryBadge(c) ?? undefined,
    h('span', { style: 'font-size:11px;color:var(--fg3);' }, `last used: ${formatDate(c.last_used_at)}`),
  ));

  if (c.description) {
    card.appendChild(h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:6px;' }, c.description));
  }

  // Metadata grid
  const metaItems: Array<[string, string]> = [
    ['Audit chat ID', c.audit_chat_id ?? `mcp-gateway:${c.name}`],
    ['Allowed classes', allowed.length === 0 ? '(inherit defaults)' : allowed.join(', ')],
    ['Rate limit', c.rate_limit_per_minute ? `${c.rate_limit_per_minute}/min` : '—'],
    ['Token hash', c.token_hash.slice(0, 16) + '…'],
    ['Expires at', c.expires_at ? formatDate(c.expires_at) : '(no expiry)'],
    ['Last rotated', formatDate(c.rotated_at)],
    ['Created', formatDate(c.created_at)],
  ];
  if (c.revoked_at) metaItems.push(['Revoked', formatDate(c.revoked_at)]);
  card.appendChild(
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;font-size:11px;margin-bottom:8px;' },
      ...metaItems.map(([k, v]) =>
        h('div', { style: 'padding:1px 0;' },
          h('span', { style: 'color:var(--fg3);' }, k + ': '),
          h('span', { style: 'color:var(--fg1);font-family:monospace;' }, v),
        ),
      ),
    ),
  );

  if (err) {
    card.appendChild(h('div', { style: 'font-size:12px;color:#c62828;margin-bottom:6px;' }, err));
  }

  // Action buttons — rotate is hidden on revoked clients (no point)
  const actions = h('div', { style: 'display:flex;gap:6px;' });
  if (!isRevoked) {
    actions.appendChild(h('button', {
      className: 'nav-btn',
      disabled: !!acting,
      'data-testid': `gateway-rotate-${c.id}`,
      style: 'padding:4px 10px;font-size:11px;',
      onClick: () => void rotateClient(c, render),
    }, acting === 'rotating' ? '…' : '↻ Rotate token'));
    actions.appendChild(h('button', {
      className: 'nav-btn',
      disabled: !!acting,
      'data-testid': `gateway-revoke-${c.id}`,
      style: 'padding:4px 10px;font-size:11px;color:#e65100;',
      onClick: () => void revokeClient(c, render),
    }, acting === 'revoking' ? '…' : '⊘ Revoke'));
  }
  actions.appendChild(h('button', {
    className: 'nav-btn',
    disabled: !!acting,
    'data-testid': `gateway-delete-${c.id}`,
    style: 'padding:4px 10px;font-size:11px;color:#c62828;',
    onClick: () => void deleteClient(c, render),
  }, acting === 'deleting' ? '…' : '🗑 Delete'));
  card.appendChild(actions);

  return card;
}

// ── Top-level view ───────────────────────────────────────────

export function renderMCPGatewayClientsView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  if (!clientsState.initialized && !clientsState.loading) {
    void loadClients(render);
  }

  const container = h('div', { style: 'max-width:900px;' });

  // Header
  container.appendChild(
    h('div', { style: 'margin-bottom:16px;' },
      h('h3', { style: 'margin:0 0 4px;font-size:16px;' }, 'MCP Gateway Clients'),
      h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
        'Per-client bearer tokens for the MCP gateway. Each client gets a distinct audit chatId and may be scoped to specific allocation classes. Tokens are SHA-256 hashed at rest and revealed in plaintext exactly once at create or rotate time.'
      ),
    ),
  );

  const banner = renderTokenBanner(render);
  if (banner) container.appendChild(banner);

  // Toolbar
  container.appendChild(
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;' },
      h('button', {
        className: 'nav-btn',
        'data-testid': 'gateway-new-client',
        style: 'padding:6px 14px;font-size:12px;font-weight:600;background:var(--accent,#0078d4);color:#fff;border:none;border-radius:4px;cursor:pointer;',
        onClick: () => {
          clientsState.showCreateForm = !clientsState.showCreateForm;
          clientsState.createError = null;
          render();
        },
      }, clientsState.showCreateForm ? '× Cancel' : '+ New client'),
      h('span', { style: 'flex:1;' }),
      h('button', {
        className: 'nav-btn',
        style: 'font-size:11px;padding:4px 10px;',
        onClick: () => void loadClients(render),
      }, '↻ Refresh'),
    ),
  );

  if (clientsState.showCreateForm) {
    container.appendChild(renderCreateForm(render));
  }

  if (clientsState.error) {
    container.appendChild(h('div', { style: 'padding:16px;color:#c62828;background:#fce8e6;border-radius:6px;font-size:13px;' }, clientsState.error));
    return container;
  }

  if (clientsState.loading) {
    container.appendChild(h('div', { style: 'padding:32px;text-align:center;color:var(--fg2);font-size:13px;' }, 'Loading…'));
    return container;
  }

  if (clientsState.clients.length === 0) {
    container.appendChild(
      h('div', {
        style: 'padding:40px;text-align:center;color:var(--fg2);font-size:13px;border:1px dashed var(--border1);border-radius:6px;',
      },
        h('div', { style: 'font-size:32px;margin-bottom:8px;' }, '🔑'),
        h('div', { style: 'font-weight:600;margin-bottom:4px;' }, 'No gateway clients yet'),
        h('div', { style: 'font-size:12px;' }, 'Click "+ New client" to mint a bearer token for an external MCP consumer.'),
      ),
    );
    return container;
  }

  container.appendChild(
    h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:10px;' },
      `${clientsState.clients.length} client${clientsState.clients.length !== 1 ? 's' : ''}`,
    ),
  );
  for (const c of clientsState.clients) {
    container.appendChild(renderClientRow(c, render));
  }

  return container;
}
