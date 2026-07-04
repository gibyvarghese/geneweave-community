/**
 * W9b Gap 1 tests — /api/me/memories user-authored memory routes.
 *
 * In-memory DatabaseAdapter stub over semantic_memory + entity_memory; no real
 * SQLite, no LLM. Covers CRUD round-trip, correction lineage, clear-all confirm
 * gate, governance read-only (403 managedByOrg), fail-closed governance error,
 * cross-principal 404, and principal isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerMeMemoryRoutes, type MemoryGovernanceGate } from './me-memories.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { SemanticMemoryRow, EntityMemoryRow } from '../db-types/memory.js';
import type { AuthContext } from '../auth.js';

// ── Router harness ────────────────────────────────────────────────────────────

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
    end(data?: string) { body = data ?? ''; },
    write(_chunk: string) {},
    json() { return JSON.parse(body || '{}'); },
    get status() { return statusCode; },
    get raw() { return body; },
  };
}

// ── DB stub ─────────────────────────────────────────────────────────────────

function buildDb() {
  const semantic = new Map<string, SemanticMemoryRow>();
  const entities: EntityMemoryRow[] = [];
  let seq = 0;
  const db = {
    _semantic: semantic,
    _entities: entities,
    async saveSemanticMemory(m: { id: string; userId: string; tenantId?: string; content: string; memoryType?: string; source?: string; metadata?: string }) {
      const now = new Date(Date.now() + (++seq)).toISOString();
      const existing = semantic.get(m.id);
      semantic.set(m.id, {
        id: m.id,
        user_id: m.userId,
        chat_id: null,
        tenant_id: m.tenantId ?? null,
        content: m.content,
        memory_type: m.memoryType ?? 'semantic',
        source: m.source ?? 'assistant',
        embedding: null,
        metadata: m.metadata ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    },
    async getSemanticMemoryById(id: string, userId: string) {
      const r = semantic.get(id);
      return r && r.user_id === userId ? r : null;
    },
    async listSemanticMemory(userId: string, _limit?: number) {
      return [...semantic.values()].filter((r) => r.user_id === userId);
    },
    async deleteSemanticMemory(id: string, userId: string) {
      const r = semantic.get(id);
      if (r && r.user_id === userId) semantic.delete(id);
    },
    async clearUserSemanticMemory(userId: string) {
      for (const [id, r] of semantic) if (r.user_id === userId) semantic.delete(id);
    },
    async listEntities(userId: string) {
      return entities.filter((e) => e.user_id === userId);
    },
    async clearUserEntityMemory(userId: string) {
      for (let i = entities.length - 1; i >= 0; i--) if (entities[i]!.user_id === userId) entities.splice(i, 1);
    },
    async listMemoryGovernance() { return []; },
  };
  return db as unknown as DatabaseAdapter & typeof db;
}

const ALLOW_GATE: MemoryGovernanceGate = { async canMutate() { return true; } };

function authFor(userId: string, tenantId: string | null = 't1'): AuthContext {
  return { userId, email: `${userId}@x.test`, sessionId: 's', csrfToken: 'c', persona: 'tenant_user', tenantId };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('W9b Gap 1 — /api/me/memories', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
    registerMeMemoryRoutes(router as any, db, { governance: ALLOW_GATE });
  });

  it('401s without auth', async () => {
    const res = await router.dispatch('GET', '/api/me/memories', '{}', null);
    expect(res.status).toBe(401);
  });

  it('creates a user-authored memory and lists it under user-authored', async () => {
    const create = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'I prefer dark mode' }), authFor('u1'));
    expect(create.status).toBe(201);
    const list = await router.dispatch('GET', '/api/me/memories', '{}', authFor('u1'));
    expect(list.status).toBe(200);
    const j = list.json();
    expect(j.memories['user-authored']).toHaveLength(1);
    expect(j.memories['user-authored'][0].content).toBe('I prefer dark mode');
    expect(j.memories['user-authored'][0].provenance.source).toBe('user');
  });

  it('rejects empty and oversized content', async () => {
    const empty = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: '   ' }), authFor('u1'));
    expect(empty.status).toBe(400);
    const big = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'x'.repeat(2001) }), authFor('u1'));
    expect(big.status).toBe(400);
  });

  it('correction preserves lineage: original superseded, corrected entry surfaced', async () => {
    const create = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'I live in London' }), authFor('u1'));
    const id = create.json().id;
    const patch = await router.dispatch('PATCH', `/api/me/memories/${id}`, JSON.stringify({ content: 'I live in Auckland', reason: 'moved' }), authFor('u1'));
    expect(patch.status).toBe(200);
    expect(patch.json().correctedFrom).toBe(id);

    // Original row is now marked superseded and excluded from the list;
    // the corrected entry is shown instead.
    const original = db._semantic.get(id)!;
    expect(JSON.parse(original.metadata!)._supersededBy).toBeTruthy();

    const list = await router.dispatch('GET', '/api/me/memories', '{}', authFor('u1'));
    const ua = list.json().memories['user-authored'];
    expect(ua).toHaveLength(1);
    expect(ua[0].content).toBe('I live in Auckland');
    expect(ua[0].id).not.toBe(id);
  });

  it('deletes a single memory', async () => {
    const create = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'temp note' }), authFor('u1'));
    const id = create.json().id;
    const del = await router.dispatch('DELETE', `/api/me/memories/${id}`, '{}', authFor('u1'));
    expect(del.status).toBe(200);
    const list = await router.dispatch('GET', '/api/me/memories', '{}', authFor('u1'));
    expect(list.json().memories['user-authored']).toHaveLength(0);
  });

  it('clear-all requires confirm:true', async () => {
    await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'a' }), authFor('u1'));
    const noConfirm = await router.dispatch('DELETE', '/api/me/memories', JSON.stringify({}), authFor('u1'));
    expect(noConfirm.status).toBe(400);
    const confirm = await router.dispatch('DELETE', '/api/me/memories', JSON.stringify({ confirm: true }), authFor('u1'));
    expect(confirm.status).toBe(200);
    const list = await router.dispatch('GET', '/api/me/memories', '{}', authFor('u1'));
    expect(list.json().memories['user-authored']).toHaveLength(0);
  });

  it('governance read-only ⇒ 403 managedByOrg', async () => {
    const r2 = buildRouter();
    registerMeMemoryRoutes(r2 as any, db, { governance: { async canMutate() { return false; } } });
    const res = await r2.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'blocked' }), authFor('u1'));
    expect(res.status).toBe(403);
    expect(res.json().managedByOrg).toBe(true);
  });

  it('governance evaluation error ⇒ 403 (fail closed)', async () => {
    const r2 = buildRouter();
    registerMeMemoryRoutes(r2 as any, db, { governance: { async canMutate() { throw new Error('policy backend down'); } } });
    const res = await r2.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'x' }), authFor('u1'));
    expect(res.status).toBe(403);
    expect(res.json().managedByOrg).toBe(true);
  });

  it('cross-principal id ⇒ 404 (no leak) on PATCH and DELETE', async () => {
    const create = await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'owned by u1' }), authFor('u1'));
    const id = create.json().id;
    const patch = await router.dispatch('PATCH', `/api/me/memories/${id}`, JSON.stringify({ content: 'hijack' }), authFor('u2'));
    expect(patch.status).toBe(404);
    const del = await router.dispatch('DELETE', `/api/me/memories/${id}`, '{}', authFor('u2'));
    expect(del.status).toBe(404);
  });

  it('principal isolation: u2 does not see u1 memories', async () => {
    await router.dispatch('POST', '/api/me/memories', JSON.stringify({ content: 'u1 secret' }), authFor('u1'));
    const list = await router.dispatch('GET', '/api/me/memories', '{}', authFor('u2'));
    expect(list.json().memories['user-authored']).toHaveLength(0);
  });
});
