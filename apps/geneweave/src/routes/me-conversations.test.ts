/**
 * SP2 tests — GET/PATCH /api/me/conversations
 *
 * In-memory DatabaseAdapter stub + recording router (mirrors w9-me.test.ts).
 * Covers: list shape, search filter, pin reorder, archive hide, cross-principal
 * 404, PATCH flag updates + validation, hasPendingAction via injected resolver
 * and via the shared in-memory task repo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerMeConversationsRoutes } from './me-conversations.js';
import { meTaskRepo } from './me-stores.js';
import { createActionItem } from '@weaveintel/human-tasks';
import type { DatabaseAdapter, ConversationRow, ConversationListOptions, ConversationFlags } from '../db-types.js';

// ── Recording router stub ────────────────────────────────────────────────────

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) => (path: string, handler: Handler) => routes.push({ method, path, handler });
  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    put: addRoute('PUT'),
    del: addRoute('DELETE'),
    add: (method: string, path: string, handler: Handler) => routes.push({ method, path, handler }),
    routes,
    async dispatch(method: string, path: string, body = '{}', auth?: any, headers: Record<string, string> = {}) {
      const entry = routes.find((r) => r.method === method && (r.path === path || matchPath(r.path, path) !== null));
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const params = matchPath(entry.path, path) ?? {};
      const res = buildResponse();
      const bodyBuf = Buffer.from(body);
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const req = {
        url: path,
        headers,
        socket: { on: vi.fn() },
        resume: vi.fn(),
        on(event: string, cb: (...args: any[]) => void) {
          listeners[event] = listeners[event] ?? [];
          listeners[event]!.push(cb);
          if (event === 'end') {
            Promise.resolve().then(() => {
              for (const l of listeners['data'] ?? []) l(bodyBuf);
              for (const l of listeners['end'] ?? []) l();
            });
          }
          return req;
        },
      };
      await entry.handler(req, res, params, auth);
      return res;
    },
  };
}

function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const pParts = pattern.split('/');
  const aParts = actual.split('?')[0]!.split('/');
  if (pParts.length !== aParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i]!.startsWith(':')) params[pParts[i]!.slice(1)] = aParts[i]!;
    else if (pParts[i] !== aParts[i]) return null;
  }
  return params;
}

function buildResponse() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  return {
    writeHead(code: number, hdrs?: Record<string, string>) { statusCode = code; if (hdrs) Object.assign(headers, hdrs); },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    end(data?: string) { body = data ?? ''; },
    json() { return JSON.parse(body); },
    get status() { return statusCode; },
    get raw() { return body; },
    get headers() { return headers; },
  };
}

// ── In-memory chat store stub ────────────────────────────────────────────────

interface StoredChat extends ConversationRow { user_id: string; _seq: number }

function buildDb() {
  const chats = new Map<string, StoredChat>();
  const messages = new Map<string, any[]>();
  let seq = 0;

  function seed(c: { id: string; userId: string; title: string; snippet?: string; mode?: string; pinned?: boolean; archived?: boolean; updatedAt?: string }) {
    seq += 1;
    chats.set(c.id, {
      id: c.id,
      user_id: c.userId,
      title: c.title,
      snippet: c.snippet ?? null,
      mode: c.mode ?? 'agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      pinned: c.pinned ? 1 : 0,
      archived: c.archived ? 1 : 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: c.updatedAt ?? `2026-01-01T00:00:0${seq % 10}.000Z`,
      _seq: seq,
    });
  }

  function toRow(c: StoredChat): ConversationRow {
    const { user_id: _u, _seq: _s, ...row } = c;
    return row;
  }

  function seedMessage(m: { id: string; chatId: string; role: string; content: string; createdAt?: string }) {
    const list = messages.get(m.chatId) ?? [];
    list.push({
      id: m.id,
      chat_id: m.chatId,
      role: m.role,
      content: m.content,
      metadata: null,
      tokens_used: 0,
      cost: 0,
      latency_ms: 0,
      created_at: m.createdAt ?? '2026-01-01T00:00:00.000Z',
    });
    messages.set(m.chatId, list);
  }

  const db = {
    _seed: seed,
    _seedMessage: seedMessage,
    _chats: chats,
    async getMessages(chatId: string): Promise<any[]> {
      return messages.get(chatId) ?? [];
    },
    async listUserConversations(userId: string, opts: ConversationListOptions = {}): Promise<ConversationRow[]> {
      const filter = opts.filter ?? 'active';
      let rows = [...chats.values()].filter((c) => c.user_id === userId);
      if (filter === 'active') rows = rows.filter((c) => c.archived === 0);
      else if (filter === 'archived') rows = rows.filter((c) => c.archived === 1);
      else if (filter === 'pinned') rows = rows.filter((c) => c.pinned === 1 && c.archived === 0);
      const q = (opts.query ?? '').trim().toLowerCase();
      if (q) rows = rows.filter((c) => c.title.toLowerCase().includes(q) || (c.snippet ?? '').toLowerCase().includes(q));
      rows.sort((a, b) => (b.pinned - a.pinned) || b.updated_at.localeCompare(a.updated_at) || b._seq - a._seq);
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 50;
      return rows.slice(offset, offset + limit).map(toRow);
    },
    async getUserConversation(id: string, userId: string): Promise<ConversationRow | null> {
      const c = chats.get(id);
      return c && c.user_id === userId ? toRow(c) : null;
    },
    async setConversationFlags(id: string, userId: string, flags: ConversationFlags): Promise<ConversationRow | null> {
      const c = chats.get(id);
      if (!c || c.user_id !== userId) return null;
      if (flags.pinned !== undefined) c.pinned = flags.pinned ? 1 : 0;
      if (flags.archived !== undefined) c.archived = flags.archived ? 1 : 0;
      if (flags.title !== undefined) c.title = flags.title;
      return toRow(c);
    },
  };
  return db as unknown as DatabaseAdapter & {
    _seed: typeof seed;
    _seedMessage: typeof seedMessage;
    _chats: Map<string, StoredChat>;
  };
}

const AUTH = { userId: 'user-1', tenantId: 'tenant-a', role: 'user' };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SP2 /api/me/conversations', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
    // Default: no pending actions (deterministic) unless a test overrides.
    registerMeConversationsRoutes(router as any, db as any, {
      pendingActionResolver: async () => new Set<string>(),
    });
  });

  it('lists conversations with the full response shape', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'First chat', snippet: 'hello there', mode: 'agent' });
    const res = await router.dispatch('GET', '/api/me/conversations', '{}', AUTH);
    expect(res.status).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: 'c1',
      title: 'First chat',
      snippet: 'hello there',
      mode: 'agent',
      pinned: false,
      archived: false,
      hasPendingAction: false,
      participants: ['user-1'],
      unread: false,
      runStatus: null,
    });
    expect(typeof conversations[0].updatedAt).toBe('string');
  });

  it('filters by search query against title and snippet', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Budget planning' });
    db._seed({ id: 'c2', userId: 'user-1', title: 'Random thoughts', snippet: 'the budget is tight' });
    db._seed({ id: 'c3', userId: 'user-1', title: 'Unrelated' });
    const res = await router.dispatch('GET', '/api/me/conversations?query=budget', '{}', AUTH);
    const ids = res.json().conversations.map((c: any) => c.id).sort();
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('floats pinned conversations to the top regardless of recency', async () => {
    db._seed({ id: 'old', userId: 'user-1', title: 'Old but pinned', pinned: true, updatedAt: '2026-01-01T00:00:00.000Z' });
    db._seed({ id: 'new', userId: 'user-1', title: 'New unpinned', updatedAt: '2026-06-01T00:00:00.000Z' });
    const res = await router.dispatch('GET', '/api/me/conversations', '{}', AUTH);
    const ids = res.json().conversations.map((c: any) => c.id);
    expect(ids[0]).toBe('old');
    expect(ids[1]).toBe('new');
  });

  it('hides archived conversations by default and reveals them with filter=archived', async () => {
    db._seed({ id: 'a', userId: 'user-1', title: 'Active' });
    db._seed({ id: 'z', userId: 'user-1', title: 'Archived one', archived: true });
    const def = await router.dispatch('GET', '/api/me/conversations', '{}', AUTH);
    expect(def.json().conversations.map((c: any) => c.id)).toEqual(['a']);
    const arch = await router.dispatch('GET', '/api/me/conversations?filter=archived', '{}', AUTH);
    expect(arch.json().conversations.map((c: any) => c.id)).toEqual(['z']);
  });

  it('PATCH pins a conversation and echoes the updated record', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Pin me' });
    const res = await router.dispatch('PATCH', '/api/me/conversations/c1', JSON.stringify({ pinned: true }), AUTH);
    expect(res.status).toBe(200);
    expect(res.json().conversation).toMatchObject({ id: 'c1', pinned: true });
  });

  it('PATCH renames a conversation', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Old name' });
    const res = await router.dispatch('PATCH', '/api/me/conversations/c1', JSON.stringify({ title: '  New name  ' }), AUTH);
    expect(res.status).toBe(200);
    expect(res.json().conversation.title).toBe('New name');
  });

  it('hides cross-principal conversations behind a 404 on PATCH', async () => {
    db._seed({ id: 'c1', userId: 'someone-else', title: 'Not yours' });
    const res = await router.dispatch('PATCH', '/api/me/conversations/c1', JSON.stringify({ pinned: true }), AUTH);
    expect(res.status).toBe(404);
  });

  it('rejects an empty PATCH body with 400', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'x' });
    const res = await router.dispatch('PATCH', '/api/me/conversations/c1', JSON.stringify({}), AUTH);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid title type with 400', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'x' });
    const res = await router.dispatch('PATCH', '/api/me/conversations/c1', JSON.stringify({ title: 123 }), AUTH);
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await router.dispatch('GET', '/api/me/conversations', '{}', undefined);
    expect(res.status).toBe(401);
  });

  it('derives hasPendingAction from an open task in the shared repo (default resolver)', async () => {
    // Re-register with the real default resolver (no override).
    router = buildRouter();
    registerMeConversationsRoutes(router as any, db as any);
    const convId = `c-pending-${Date.now()}`;
    db._seed({ id: convId, userId: 'user-1', title: 'Has a pending task' });
    db._seed({ id: 'c-clean', userId: 'user-1', title: 'No tasks' });
    // Open action-item whose provenance points at the conversation.
    await meTaskRepo.save(createActionItem({
      assignee: 'user-1',
      title: 'Approve the thing',
      provenance: { createdBy: 'agent', sourceRunId: convId },
    }));
    const res = await router.dispatch('GET', '/api/me/conversations', '{}', AUTH);
    const byId = Object.fromEntries(res.json().conversations.map((c: any) => [c.id, c.hasPendingAction]));
    expect(byId[convId]).toBe(true);
    expect(byId['c-clean']).toBe(false);
  });
});

describe('SP2 GET /api/me/conversations/:id/messages', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
    registerMeConversationsRoutes(router as any, db as any, {
      pendingActionResolver: async () => new Set<string>(),
    });
  });

  it('returns the visible transcript in chronological order', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Chat' });
    db._seedMessage({ id: 'm1', chatId: 'c1', role: 'user', content: 'Who are you?', createdAt: '2026-01-01T00:00:01.000Z' });
    db._seedMessage({ id: 'm2', chatId: 'c1', role: 'assistant', content: 'I am GeneWeave.', createdAt: '2026-01-01T00:00:02.000Z' });
    const res = await router.dispatch('GET', '/api/me/conversations/c1/messages', '{}', AUTH);
    expect(res.status).toBe(200);
    const { messages } = res.json();
    expect(messages).toEqual([
      { id: 'm1', role: 'user', content: 'Who are you?', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'm2', role: 'assistant', content: 'I am GeneWeave.', createdAt: '2026-01-01T00:00:02.000Z' },
    ]);
  });

  it('omits system and tool rows from the transcript', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Chat' });
    db._seedMessage({ id: 'sys', chatId: 'c1', role: 'system', content: 'You are helpful.' });
    db._seedMessage({ id: 'm1', chatId: 'c1', role: 'user', content: 'Hi' });
    db._seedMessage({ id: 'tool', chatId: 'c1', role: 'tool', content: '{"result":1}' });
    db._seedMessage({ id: 'm2', chatId: 'c1', role: 'assistant', content: 'Hello' });
    const res = await router.dispatch('GET', '/api/me/conversations/c1/messages', '{}', AUTH);
    expect(res.json().messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
  });

  it('hides cross-principal conversations behind a 404', async () => {
    db._seed({ id: 'c1', userId: 'someone-else', title: 'Not yours' });
    db._seedMessage({ id: 'm1', chatId: 'c1', role: 'user', content: 'secret' });
    const res = await router.dispatch('GET', '/api/me/conversations/c1/messages', '{}', AUTH);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown conversation', async () => {
    const res = await router.dispatch('GET', '/api/me/conversations/missing/messages', '{}', AUTH);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    db._seed({ id: 'c1', userId: 'user-1', title: 'Chat' });
    const res = await router.dispatch('GET', '/api/me/conversations/c1/messages', '{}', undefined);
    expect(res.status).toBe(401);
  });
});
