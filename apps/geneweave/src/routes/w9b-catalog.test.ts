/**
 * W9b Gap 2 tests — /api/me/catalog via the shared surface-catalog resolver.
 *
 * In-memory DatabaseAdapter stub feeding the four catalog sources (modes,
 * live-agents, models, skills); no real SQLite, no LLM. Covers role-gated
 * visibility (tenant_user lacks `agent` kind, tenant_admin sees it), fail-soft
 * source isolation (one throwing source does not sink the rest), starter-prompt
 * sibling shape, and per-principal cache isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerMeRoutes } from './me.js';
import { createMeCatalogResolver } from '../me-catalog.js';
import type { DatabaseAdapter } from '../db-types.js';
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
    async dispatch(method: string, path: string, body = '{}', auth?: any) {
      const entry = routes.find((r) => r.method === method && (r.path === path || matchPath(r.path, path) !== null));
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const params = matchPath(entry.path, path) ?? {};
      const res = buildResponse();
      const req = { url: path, headers: {}, socket: { on: vi.fn() }, resume: vi.fn(), on: vi.fn() };
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

interface DbState { failAgents?: boolean }

function buildDb(state: DbState = {}) {
  return {
    async listModeLabels(surfaceId: string) {
      if (surfaceId !== 'web') return [];
      return [{
        id: 'mode-1', surface_id: 'web', mode_key: 'assistant', label: 'Assistant',
        description: 'General assistant', icon: null, is_default: 1, sort_order: 0,
        enabled: 1, metadata: null, created_at: new Date().toISOString(),
      }];
    },
    async listLiveAgents(_filter?: unknown) {
      if (state.failAgents) throw new Error('agents source down');
      return [{
        id: 'agent-1', name: 'Research Agent', role_key: 'researcher', role_label: 'Researcher',
        mesh_id: 'mesh-1', status: 'ACTIVE',
      }];
    },
    async listModelPricing() {
      return [
        { id: 'mp-1', model_id: 'gpt-x', provider: 'openai', display_name: 'GPT-X', enabled: 1 },
        { id: 'mp-2', model_id: 'old-model', provider: 'openai', display_name: 'Old', enabled: 0 },
      ];
    },
    async listSkills() {
      return [
        { id: 'skill-1', name: 'Summarize', description: 'Summarize text', enabled: 1 },
        { id: 'skill-2', name: 'Disabled', description: null, enabled: 0 },
      ];
    },
    async listStarterPrompts(surfaceId: string) {
      if (surfaceId !== 'web') return [];
      return [{ id: 'sp-1', surface_id: 'web', label: 'Help me write', prompt_text: 'Help…', sort_order: 0, enabled: 1, metadata: null, created_at: '' }];
    },
  } as unknown as DatabaseAdapter;
}

function authFor(userId: string, persona: string, tenantId = 't1'): AuthContext {
  return {
    userId, email: `${userId}@x.test`, sessionId: 's-' + userId,
    csrfToken: 'csrf', persona, tenantId,
  } as AuthContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('W9b Gap 2 — /api/me/catalog', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: DatabaseAdapter;

  function wire(dbState: DbState = {}) {
    db = buildDb(dbState);
    router = buildRouter();
    registerMeRoutes(router as any, db, { catalogResolver: createMeCatalogResolver(db) });
  }

  beforeEach(() => wire());

  it('returns 401 without auth', async () => {
    const res = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', undefined);
    expect(res.status).toBe(401);
  });

  it('tenant_admin sees mode, agent, model and skill kinds', async () => {
    const res = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', authFor('admin', 'tenant_admin'));
    expect(res.status).toBe(200);
    const body = res.json() as any;
    const kinds = new Set(body.entries.map((e: any) => e.kind));
    expect(kinds).toEqual(new Set(['mode', 'agent', 'model', 'skill']));
    expect(body.surfaceId).toBe('web');
    expect(body.starterPrompts).toHaveLength(1);
    // disabled model + disabled skill excluded
    expect(body.entries.find((e: any) => e.id === 'old-model')).toBeUndefined();
    expect(body.entries.find((e: any) => e.id === 'skill-2')).toBeUndefined();
  });

  it('tenant_user is denied agent entries but keeps mode/model/skill', async () => {
    const res = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', authFor('user', 'tenant_user'));
    expect(res.status).toBe(200);
    const body = res.json() as any;
    const kinds = new Set(body.entries.map((e: any) => e.kind));
    expect(kinds.has('agent')).toBe(false);
    expect(kinds).toEqual(new Set(['mode', 'model', 'skill']));
  });

  it('a throwing source is isolated; remaining entries still returned', async () => {
    wire({ failAgents: true });
    const res = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', authFor('admin', 'tenant_admin'));
    expect(res.status).toBe(200);
    const body = res.json() as any;
    const kinds = new Set(body.entries.map((e: any) => e.kind));
    expect(kinds.has('agent')).toBe(false);
    expect(kinds).toEqual(new Set(['mode', 'model', 'skill']));
  });

  it('empty entries for unknown surface', async () => {
    const res = await router.dispatch('GET', '/api/me/catalog?surface=unknown', '{}', authFor('admin', 'tenant_admin'));
    expect(res.status).toBe(200);
    const body = res.json() as any;
    // unknown surface → no modes, no starters; agent/model/skill are surface-agnostic
    expect(body.entries.find((e: any) => e.kind === 'mode')).toBeUndefined();
    expect(body.starterPrompts).toHaveLength(0);
  });

  it('per-principal cache isolation — admin and user resolve independently', async () => {
    const adminRes = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', authFor('admin', 'tenant_admin'));
    const userRes = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', authFor('user', 'tenant_user'));
    const adminKinds = new Set((adminRes.json() as any).entries.map((e: any) => e.kind));
    const userKinds = new Set((userRes.json() as any).entries.map((e: any) => e.kind));
    expect(adminKinds.has('agent')).toBe(true);
    expect(userKinds.has('agent')).toBe(false);
  });
});
