// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — the CONNECT (MCP) panel.
 *
 * --- For someone new to this ---
 * This is the "let another AI app use my notes" panel. MCP (Model Context Protocol) is the standard
 * way apps like Claude Desktop or ChatGPT plug into outside data. Here you create a personal
 * connection KEY (a token) and copy the connection address; paste both into the other app and it can
 * search and read your notes (and, if you allow it, create new ones). The key is shown ONCE — copy it
 * then. You can revoke any key at any time. A self-contained DOM panel (no framework).
 */
import { h } from './dom.js';
import { api } from './api.js';

interface TokenRow { id: string; name: string; scope: string; token_prefix: string; enabled: number; created_at: string; last_used_at: string | null }

export function renderMcpPanel(): HTMLElement {
  const root = h('div', { className: 'gw-mcp' }) as HTMLElement;
  let tokens: TokenRow[] = []; let endpoint = '/api/mcp/notes'; let justCreated: { token: string; name: string } | null = null; let busy = false; let err = '';

  async function load(): Promise<void> {
    try { const r = await api.get('/api/me/mcp-tokens'); const d = await r.json().catch(() => ({})) as { tokens?: TokenRow[]; endpoint?: string }; tokens = (d.tokens ?? []).filter((t) => t.enabled !== 0); endpoint = d.endpoint ?? endpoint; } catch { tokens = []; }
    paint();
  }
  async function create(name: string, scope: string): Promise<void> {
    if (busy) return; busy = true; err = ''; paint();
    try { const r = await api.post('/api/me/mcp-tokens', { name, scope }); const d = await r.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: string }; if (d.ok && d.token) justCreated = { token: d.token, name }; else err = d.error ?? 'Could not create a token.'; }
    finally { busy = false; await load(); }
  }
  async function revoke(id: string): Promise<void> { await api.del(`/api/me/mcp-tokens/${id}`); await load(); }

  function fullUrl(): string { return `${location.origin}${endpoint}`; }

  function paint(): void {
    root.innerHTML = '';
    root.appendChild(h('p', { className: 'gw-mcp-intro' }, 'Connect an outside AI app (Claude Desktop, ChatGPT, Cursor) to your notes using MCP. Create a personal key below, then add this connection to the other app:'));
    root.appendChild(h('div', { className: 'gw-mcp-endpoint' }, h('span', { className: 'gw-mcp-lbl' }, 'MCP server URL'), h('code', null, fullUrl())));

    if (justCreated) {
      root.appendChild(h('div', { className: 'gw-mcp-secret' },
        h('div', { className: 'gw-mcp-secret-title' }, `🔑 Your new key “${justCreated.name}” (copy it now — it won’t be shown again):`),
        h('code', { className: 'gw-mcp-token' }, justCreated.token),
        h('div', { className: 'gw-mcp-secret-hint' }, 'In the other app, add an MCP server with the URL above and this key as a Bearer token.'),
      ));
    }

    // Existing keys.
    if (tokens.length) {
      const list = h('div', { className: 'gw-mcp-list' });
      for (const t of tokens) {
        list.appendChild(h('div', { className: 'gw-mcp-row' },
          h('span', { className: 'gw-mcp-name' }, t.name),
          h('span', { className: 'gw-mcp-scope' }, t.scope === 'read' ? 'read-only' : 'read + write'),
          h('span', { className: 'gw-mcp-pfx' }, `${t.token_prefix}…`),
          h('button', { className: 'gw-mcp-revoke', onClick: () => void revoke(t.id) }, 'Revoke'),
        ));
      }
      root.appendChild(list);
    }

    // Create form.
    const name = h('input', { className: 'gw-mcp-input', placeholder: 'Key name, e.g. Claude Desktop' }) as HTMLInputElement;
    const scope = h('select', { className: 'gw-mcp-input' }, h('option', { value: 'readwrite' }, 'Read + write (create/append)'), h('option', { value: 'read' }, 'Read-only')) as HTMLSelectElement;
    if (err) root.appendChild(h('p', { className: 'gw-mcp-error' }, err));
    root.appendChild(h('div', { className: 'gw-mcp-form' },
      h('div', { className: 'gw-mcp-form-title' }, '➕ New connection key'),
      name, scope,
      h('button', { className: 'gw-btn-emerald gw-mcp-create', disabled: busy, onClick: () => void create(name.value || 'MCP key', scope.value) }, busy ? 'Creating…' : 'Create key'),
    ));
    root.appendChild(h('p', { className: 'gw-mcp-foot' }, 'Each key belongs to YOU — a connected app only ever sees your own notes, and writes are staged for your approval in the app.'));
  }

  void load();
  return root;
}
