// SPDX-License-Identifier: MIT
/**
 * geneWeave MCP NOTE-VAULT server (weaveNotes Phase 3).
 *
 * Exposes a user's notes to an EXTERNAL agent (Claude Desktop / ChatGPT / Cursor) over the Model
 * Context Protocol, so they can search / read / create / append the user's notes from another app.
 *
 * The protocol wire-handling lives in the pure `@weaveintel/notes` MCP core; this layer:
 *   - AUTH: validates the per-user bearer token (hashed lookup) and resolves it to ONE user. Every
 *     tool call is owner-scoped to THAT user — the identity comes from the validated token, never
 *     from a tool argument (the #1 MCP-security control against cross-user data access).
 *   - TOOLS: wires search/read/list to the existing note services (read-only); create/append to the
 *     existing additive + suggestion paths (writes are gated by token scope AND the global config,
 *     and an append is staged as a track-changes SUGGESTION the user approves — never a silent edit).
 *   - SAFETY: note content returned to the external model is just data; the server never acts on it,
 *     and it has no external-send tool, so the "lethal trifecta" stays broken. Tokens are stored
 *     hashed; every write is recorded in the note activity log.
 */
import { extractPlainText } from '@weaveintel/notes';
import { handleMcpMessage, mcpText, MCP_PROTOCOL_VERSION, type McpTool, type McpToolResult } from '@weaveintel/mcp-server';
import { BlockDoc, pmToBlocks, blocksToMarkdown } from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import { createHash, randomBytes } from 'node:crypto';
import { createNoteSettingsService } from './note-settings-sql.js';
import { agentCreateNote, createNoteAiService } from './note-ai-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { UserMcpTokenRow } from './db-types/mcp-notes.js';

type McpDb = DatabaseAdapter;
const TOKEN_PREFIX = 'wn_mcp_';

export interface McpUser { userId: string; tenantId: string | null; scope: 'read' | 'readwrite'; tokenId: string }

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function noteUrl(id: string): string { return `/n/${id}`; }
function noteMarkdown(docJson: string | undefined | null): string {
  if (!docJson) return '';
  try { return blocksToMarkdown(BlockDoc.fromBlocks('u:mcp', pmToBlocks(JSON.parse(docJson) as unknown)).blocks()); } catch { /* */ }
  try { return extractPlainText(JSON.parse(docJson ?? '') as unknown); } catch { return ''; }
}

export function createMcpNotesServer(db: McpDb, opts: { generate?: NoteAiGenerate; now?: () => number } = {}) {
  const settings = createNoteSettingsService(db);
  const aiSvc = opts.generate ? createNoteAiService(db, opts.generate) : null;

  // ── Token management (used by the per-user /api/me/mcp-tokens API) ──────────
  /** Mint a new token for a user. Returns the PLAINTEXT once (never stored) + the stored row view. */
  async function createToken(input: { userId: string; tenantId?: string | null; name?: string; scope?: 'read' | 'readwrite' }): Promise<{ token: string; id: string; name: string; scope: string; prefix: string }> {
    const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
    const id = newUUIDv7();
    const name = (input.name ?? 'MCP token').trim().slice(0, 80) || 'MCP token';
    const scope = input.scope === 'read' ? 'read' : 'readwrite';
    const row: UserMcpTokenRow = { id, user_id: input.userId, tenant_id: input.tenantId ?? null, name, token_hash: sha256(token), token_prefix: token.slice(0, 14), scope, enabled: 1, created_at: new Date((opts.now ?? Date.now)()).toISOString(), last_used_at: null, expires_at: null };
    await db.createUserMcpToken(row);
    return { token, id, name, scope, prefix: row.token_prefix };
  }
  async function listTokens(userId: string): Promise<Array<Pick<UserMcpTokenRow, 'id' | 'name' | 'scope' | 'token_prefix' | 'enabled' | 'created_at' | 'last_used_at'>>> {
    return (await db.listUserMcpTokens(userId)).map((r) => ({ id: r.id, name: r.name, scope: r.scope, token_prefix: r.token_prefix, enabled: r.enabled, created_at: r.created_at, last_used_at: r.last_used_at }));
  }
  async function revokeToken(id: string, userId: string): Promise<void> { await db.revokeUserMcpToken(id, userId); }

  /** Validate a bearer token → the owning user (or null). Identity NEVER comes from a tool argument. */
  async function resolveToken(bearer: string | undefined): Promise<McpUser | null> {
    if (!bearer) return null;
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const row = await db.getUserMcpTokenByHash(sha256(token));
    if (!row || row.enabled === 0) return null;
    if (row.expires_at && Date.parse(row.expires_at) < (opts.now ?? Date.now)()) return null;
    void db.touchUserMcpToken(row.id);
    return { userId: row.user_id, tenantId: row.tenant_id, scope: row.scope === 'read' ? 'read' : 'readwrite', tokenId: row.id };
  }

  // ── The MCP tool registry (varies by token scope + global write config) ─────
  const READ_TOOLS: McpTool[] = [
    { name: 'search_notes', description: 'Search the user\'s notes by keyword (title + body) and get back matching notes with a snippet. Use this to find relevant notes before reading them.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search text' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, required: ['query'] } },
    { name: 'get_note', description: 'Read one note in full (Markdown) by its id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'list_notes', description: 'List the user\'s most recently updated notes (id, title, updated time).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } },
    // ChatGPT deep-research compatibility aliases.
    { name: 'search', description: 'Search the user\'s notes (ChatGPT-compatible: returns {results:[{id,title,url}]}).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'fetch', description: 'Fetch a note by id (ChatGPT-compatible: returns {id,title,text,url}).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  ];
  const WRITE_TOOLS: McpTool[] = [
    { name: 'create_note', description: 'Create a NEW note (additive — never overwrites anything). Provide a title and Markdown content.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string', description: 'Markdown body' } }, required: ['title', 'content'] } },
    { name: 'append_to_note', description: 'Append Markdown to an existing note. The change is staged as a SUGGESTION for the user to review and accept in the app (it does not take effect until they approve it).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string', description: 'Markdown to append' } }, required: ['id', 'content'] } },
  ];

  async function toolsFor(user: McpUser): Promise<McpTool[]> {
    const cfg = await settings.getConfig();
    const canWrite = user.scope === 'readwrite' && cfg.mcpNotesAllowWrites && !!aiSvc;
    return canWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  }

  /** Dispatch a tool call, owner-scoped to the token's user. */
  async function callToolFor(user: McpUser, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const json = (o: unknown): McpToolResult => mcpText(JSON.stringify(o));
    switch (name) {
      case 'search_notes':
      case 'search': {
        const query = String(args['query'] ?? '').trim();
        if (!query) return mcpText('query is required', true);
        const limit = Math.max(1, Math.min(50, Number(args['limit']) || 10));
        const rows = await db.listNotes(user.userId, { search: query, limit }) as Array<{ id: string; title?: string; doc_json?: string }>;
        const results = rows.map((r) => {
          const text = noteMarkdown(r.doc_json);
          return { id: r.id, title: r.title || '(untitled)', snippet: text.slice(0, 240), url: noteUrl(r.id) };
        });
        return json(name === 'search' ? { results: results.map((r) => ({ id: r.id, title: r.title, url: r.url })) } : { results });
      }
      case 'get_note':
      case 'fetch': {
        const id = String(args['id'] ?? '').trim();
        const note = await db.getNote(id, user.userId) as { id: string; title?: string; doc_json?: string; updated_at?: string } | null;
        if (!note) return mcpText(`Note not found: ${id}`, true); // owner-scoped: another user's note → not found
        const content = noteMarkdown(note.doc_json);
        return json(name === 'fetch'
          ? { id: note.id, title: note.title || '(untitled)', text: content, url: noteUrl(note.id), metadata: { updatedAt: note.updated_at ?? null } }
          : { id: note.id, title: note.title || '(untitled)', content, url: noteUrl(note.id), updatedAt: note.updated_at ?? null });
      }
      case 'list_notes': {
        const limit = Math.max(1, Math.min(50, Number(args['limit']) || 20));
        const rows = await db.listNotes(user.userId, { limit }) as Array<{ id: string; title?: string; updated_at?: string }>;
        return json({ notes: rows.map((r) => ({ id: r.id, title: r.title || '(untitled)', updatedAt: r.updated_at ?? null })) });
      }
      case 'create_note': {
        const cfg = await settings.getConfig();
        if (user.scope !== 'readwrite' || !cfg.mcpNotesAllowWrites) return mcpText('this token is read-only', true);
        const title = String(args['title'] ?? '').trim().slice(0, 200) || 'Untitled note';
        const content = String(args['content'] ?? '');
        const r = await agentCreateNote(db, { userId: user.userId, ...(user.tenantId ? { tenantId: user.tenantId } : {}), title, markdown: content });
        if (!r.ok || !r.noteId) return mcpText(`could not create note: ${r.error ?? 'error'}`, true);
        void settings.recordActivity({ noteId: r.noteId, userId: user.userId, tenantId: user.tenantId, action: 'created', actor: 'ai', summary: 'Created via MCP', detail: { via: 'mcp', tokenId: user.tokenId } });
        return json({ id: r.noteId, url: noteUrl(r.noteId) });
      }
      case 'append_to_note': {
        const cfg = await settings.getConfig();
        if (user.scope !== 'readwrite' || !cfg.mcpNotesAllowWrites || !aiSvc) return mcpText('this token is read-only', true);
        const id = String(args['id'] ?? '').trim();
        const content = String(args['content'] ?? '');
        if (!content.trim()) return mcpText('content is required', true);
        // Stage as a track-changes suggestion (HITL) — the external client never silently mutates a note.
        const r = await aiSvc.agentEdit({ userId: user.userId, noteId: id, markdown: content, mode: 'suggest' });
        if (!r.ok) return mcpText(`could not stage edit: ${r.error ?? 'error'}`, true);
        return json({ id, ok: true, status: 'pending_review', suggestionId: r.suggestionId ?? null, note: 'Staged as a suggestion — the user approves it in the app before it applies.' });
      }
      default: return mcpText(`Unknown tool: ${name}`, true);
    }
  }

  /**
   * Handle one raw MCP HTTP request body (a JSON-RPC message). Returns { status, body } — body is null
   * for notifications (→ 202). `bearer` is the Authorization header; an invalid/absent token → 401.
   */
  async function handleRequest(bearer: string | undefined, rawBody: string): Promise<{ status: number; body: unknown }> {
    const cfg = await settings.getConfig();
    if (!cfg.mcpNotesEnabled) return { status: 503, body: { error: 'The notes MCP server is disabled.' } };
    const user = await resolveToken(bearer);
    if (!user) return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a valid MCP bearer token is required.' } } };
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(rawBody || '{}'); } catch { return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
    const response = await handleMcpMessage(msg, {
      serverInfo: { name: 'weaveNotes', version: '1.0.0', instructions: 'Search, read, create, and append to your weaveNotes notes. Writes are staged for your approval in the app.' },
      listTools: () => toolsFor(user),
      callTool: (n, a) => callToolFor(user, n, a),
    });
    return { status: response === null ? 202 : 200, body: response };
  }

  return { createToken, listTokens, revokeToken, resolveToken, toolsFor, callToolFor, handleRequest, protocolVersion: MCP_PROTOCOL_VERSION };
}

export type McpNotesServer = ReturnType<typeof createMcpNotesServer>;
