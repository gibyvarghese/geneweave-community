/**
 * W9b Gap 4 tests — admin catalog CRUD (/api/admin/mode-labels,
 * /api/admin/starter-prompts).
 *
 * In-memory DatabaseAdapter stub reproducing the SQLite single-default
 * invariant and unique (surface_id, mode_key) constraint; no real SQLite.
 * Covers create/list/update/delete, surfaceId allow-list, length caps,
 * the at-most-one-default-per-surface invariant, duplicate mode_key 409,
 * 404 on unknown id, and the RBAC gating contract that the admin router
 * applies (admin:tenant:write — tenant_admin yes, tenant_user no).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerAdminCatalogRoutes } from '../admin/routes/catalog.js';
import { permissionForAdminRoute } from '../server-core.js';
import { canPersonaAccess } from '../rbac.js';
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
    routes,
    async dispatch(method: string, path: string, body = '{}', auth?: any) {
      const entry = routes.find((r) => r.method === method && (r.path === path || matchPath(r.path, path) !== null));
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const params = matchPath(entry.path, path) ?? {};
      const res = buildResponse();
      const req = { url: path, headers: {}, _body: body, socket: { on: vi.fn() }, resume: vi.fn(), on: vi.fn() };
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
  return {
    writeHead(code: number) { statusCode = code; },
    end(data?: string) { body = data ?? ''; },
    write(_chunk: string) {},
    json() { return JSON.parse(body || '{}'); },
    get status() { return statusCode; },
  };
}

const json = (res: any, status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); };
const readBody = async (req: any) => String(req._body ?? '{}');

// ── In-memory DB stub (mirrors SQLite invariants) ───────────────────────────

interface ModeRow { id: string; surface_id: string; mode_key: string; label: string; description: string | null; icon: string | null; is_default: number; sort_order: number; enabled: number; metadata: string | null; created_at: string }
interface PromptRow { id: string; surface_id: string; label: string; prompt_text: string; sort_order: number; enabled: number; metadata: string | null; created_at: string }

function buildDb() {
  const modes: ModeRow[] = [];
  const prompts: PromptRow[] = [];
  return {
    _modes: modes,
    _prompts: prompts,
    async adminListModeLabels(surfaceId?: string) {
      return modes.filter((m) => surfaceId === undefined || m.surface_id === surfaceId);
    },
    async getModeLabel(id: string) { return modes.find((m) => m.id === id) ?? null; },
    async createModeLabel(row: any) {
      if (modes.some((m) => m.surface_id === row.surface_id && m.mode_key === row.mode_key)) {
        throw new Error('UNIQUE constraint failed');
      }
      const isDefault = row.is_default === 1 ? 1 : 0;
      if (isDefault === 1) modes.forEach((m) => { if (m.surface_id === row.surface_id) m.is_default = 0; });
      modes.push({
        id: row.id, surface_id: row.surface_id, mode_key: row.mode_key, label: row.label,
        description: row.description ?? null, icon: row.icon ?? null, is_default: isDefault,
        sort_order: row.sort_order ?? 0, enabled: row.enabled === 0 ? 0 : 1, metadata: row.metadata ?? null,
        created_at: new Date().toISOString(),
      });
    },
    async updateModeLabel(id: string, patch: any) {
      const row = modes.find((m) => m.id === id);
      if (!row) return;
      if (patch.is_default === 1) modes.forEach((m) => { if (m.surface_id === row.surface_id) m.is_default = 0; });
      Object.assign(row, patch);
    },
    async deleteModeLabel(id: string) {
      const i = modes.findIndex((m) => m.id === id);
      if (i >= 0) modes.splice(i, 1);
    },
    async adminListStarterPrompts(surfaceId?: string) {
      return prompts.filter((p) => surfaceId === undefined || p.surface_id === surfaceId);
    },
    async getStarterPrompt(id: string) { return prompts.find((p) => p.id === id) ?? null; },
    async createStarterPrompt(row: any) {
      prompts.push({
        id: row.id, surface_id: row.surface_id, label: row.label, prompt_text: row.prompt_text,
        sort_order: row.sort_order ?? 0, enabled: row.enabled === 0 ? 0 : 1, metadata: row.metadata ?? null,
        created_at: new Date().toISOString(),
      });
    },
    async updateStarterPrompt(id: string, patch: any) {
      const row = prompts.find((p) => p.id === id);
      if (row) Object.assign(row, patch);
    },
    async deleteStarterPrompt(id: string) {
      const i = prompts.findIndex((p) => p.id === id);
      if (i >= 0) prompts.splice(i, 1);
    },
  } as unknown as DatabaseAdapter & { _modes: ModeRow[]; _prompts: PromptRow[] };
}

function adminAuth(): AuthContext {
  return { userId: 'admin1', email: 'a@x.test', sessionId: 's1', csrfToken: 'c', persona: 'tenant_admin', tenantId: 't1' } as AuthContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('W9b Gap 4 — admin catalog CRUD', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
    registerAdminCatalogRoutes(router as any, db, json, readBody);
  });

  it('rejects unauthenticated requests (401)', async () => {
    const res = await router.dispatch('GET', '/api/admin/mode-labels', '{}', null);
    expect(res.status).toBe(401);
  });

  it('creates a mode label and lists it', async () => {
    const create = await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'agent', label: 'Agent' }), adminAuth());
    expect(create.status).toBe(201);
    expect(create.json()['mode-label'].label).toBe('Agent');

    const list = await router.dispatch('GET', '/api/admin/mode-labels', '{}', adminAuth());
    expect(list.status).toBe(200);
    expect(list.json()['mode-labels']).toHaveLength(1);
  });

  it('enforces the surfaceId allow-list', async () => {
    const res = await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'watch', mode_key: 'x', label: 'X' }), adminAuth());
    expect(res.status).toBe(400);
  });

  it('rejects an over-long label', async () => {
    const res = await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'x', label: 'L'.repeat(81) }), adminAuth());
    expect(res.status).toBe(400);
  });

  it('keeps at most one default mode per surface', async () => {
    await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'assistant', label: 'Assistant', is_default: true }), adminAuth());
    await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'agent', label: 'Agent', is_default: true }), adminAuth());
    const defaults = db._modes.filter((m) => m.surface_id === 'web' && m.is_default === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.mode_key).toBe('agent');
  });

  it('rejects a duplicate mode_key on the same surface (409)', async () => {
    await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'assistant', label: 'Assistant' }), adminAuth());
    const dup = await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'assistant', label: 'Assistant 2' }), adminAuth());
    expect(dup.status).toBe(409);
  });

  it('updates and deletes a mode label; 404 on unknown id', async () => {
    const create = await router.dispatch('POST', '/api/admin/mode-labels',
      JSON.stringify({ surface_id: 'web', mode_key: 'agent', label: 'Agent' }), adminAuth());
    const id = create.json()['mode-label'].id;

    const upd = await router.dispatch('PUT', `/api/admin/mode-labels/${id}`,
      JSON.stringify({ label: 'Agent Pro', enabled: false }), adminAuth());
    expect(upd.status).toBe(200);
    expect(upd.json()['mode-label'].label).toBe('Agent Pro');
    expect(upd.json()['mode-label'].enabled).toBe(0);

    const del = await router.dispatch('DELETE', `/api/admin/mode-labels/${id}`, '{}', adminAuth());
    expect(del.status).toBe(200);
    expect(db._modes).toHaveLength(0);

    const missing = await router.dispatch('PUT', `/api/admin/mode-labels/${id}`,
      JSON.stringify({ label: 'X' }), adminAuth());
    expect(missing.status).toBe(404);
  });

  it('creates, updates, and deletes a starter prompt with length caps', async () => {
    const tooLong = await router.dispatch('POST', '/api/admin/starter-prompts',
      JSON.stringify({ surface_id: 'web', label: 'L', prompt_text: 'p'.repeat(501) }), adminAuth());
    expect(tooLong.status).toBe(400);

    const create = await router.dispatch('POST', '/api/admin/starter-prompts',
      JSON.stringify({ surface_id: 'web', label: 'Write', prompt_text: 'Help me write' }), adminAuth());
    expect(create.status).toBe(201);
    const id = create.json()['starter-prompt'].id;

    const upd = await router.dispatch('PUT', `/api/admin/starter-prompts/${id}`,
      JSON.stringify({ label: 'Compose' }), adminAuth());
    expect(upd.status).toBe(200);
    expect(upd.json()['starter-prompt'].label).toBe('Compose');

    const del = await router.dispatch('DELETE', `/api/admin/starter-prompts/${id}`, '{}', adminAuth());
    expect(del.status).toBe(200);
    expect(db._prompts).toHaveLength(0);
  });

  it('gates mutations behind admin:tenant:write (tenant_admin yes, tenant_user no)', () => {
    expect(permissionForAdminRoute('/api/admin/mode-labels', 'POST')).toBe('admin:tenant:write');
    expect(permissionForAdminRoute('/api/admin/starter-prompts', 'PUT')).toBe('admin:tenant:write');
    expect(canPersonaAccess('tenant_admin', 'admin:tenant:write')).toBe(true);
    expect(canPersonaAccess('tenant_user', 'admin:tenant:write')).toBe(false);
  });
});
