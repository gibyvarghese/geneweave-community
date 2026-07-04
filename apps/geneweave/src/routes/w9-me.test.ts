/**
 * W9 tests — /api/me/* user-scope API routes
 *
 * Tests use an in-memory DatabaseAdapter stub so no real SQLite is needed.
 * Covers: runs CRUD, run events, cancel, catalog, tasks, reminders.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerMeRoutes } from './me.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { UserRunRow, UserRunEventRow, ModeLabel, StarterPrompt } from '../db-types/adapter-me.js';

// ---------------------------------------------------------------------------
// Minimal router stub that records registered handlers
// ---------------------------------------------------------------------------

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) =>
    (path: string, handler: Handler) =>
      routes.push({ method, path, handler });

  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    put: addRoute('PUT'),
    del: addRoute('DELETE'),
    add: addRoute('ANY'),
    routes,
    async dispatch(method: string, path: string, body = '{}', auth?: any, headers: Record<string,string> = {}) {
      const entry = routes.find(
        (r) => r.method === method &&
          (r.path === path || matchPath(r.path, path) !== null),
      );
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const params = matchPath(entry.path, path) ?? {};
      const res = buildResponse();
      // Simulate Node IncomingMessage with on('data')/on('end') pattern
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
            // Emit data then end asynchronously
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

function matchPath(pattern: string, actual: string): Record<string,string> | null {
  const pParts = pattern.split('/');
  const aParts = actual.split('?')[0]!.split('/');
  if (pParts.length !== aParts.length) return null;
  const params: Record<string,string> = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i]!.startsWith(':')) {
      params[pParts[i]!.slice(1)] = aParts[i]!;
    } else if (pParts[i] !== aParts[i]) {
      return null;
    }
  }
  return params;
}

function buildResponse() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string,string> = {};
  const writes: string[] = [];
  return {
    writeHead(code: number, hdrs?: Record<string,string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end(data?: string) { body = data ?? ''; },
    write(chunk: string) { writes.push(chunk); },
    json() { return JSON.parse(body); },
    get status() { return statusCode; },
    get raw() { return body; },
    get written() { return writes; },
    get headers() { return headers; },
  };
}

// ---------------------------------------------------------------------------
// Minimal DB stub
// ---------------------------------------------------------------------------

function buildDb(): DatabaseAdapter & {
  _runs: Map<string, UserRunRow>;
  _events: Map<string, UserRunEventRow[]>;
  _modes: ModeLabel[];
  _starters: StarterPrompt[];
} {
  const runs = new Map<string, UserRunRow>();
  const events = new Map<string, UserRunEventRow[]>();
  const modes: ModeLabel[] = [];
  const starters: StarterPrompt[] = [];

  // stub idempotency
  const idempotencyMap = new Map<string, any>();

  return {
    _runs: runs,
    _events: events,
    _modes: modes,
    _starters: starters,

    // ── Me store ────────────────────────────────────────────────────────────
    async createUserRun(run: Parameters<import('../db-types/adapter-me.js').IMeStore['createUserRun']>[0]) {
      const now = new Date().toISOString();
      const row: UserRunRow = {
        id: run.id,
        user_id: run.user_id,
        tenant_id: run.tenant_id ?? null,
        status: run.status,
        surface: run.surface ?? null,
        metadata: run.metadata ?? null,
        created_at: now,
        updated_at: now,
      };
      runs.set(run.id, row);
    },
    async getUserRun(id: string, userId: string) {
      const row = runs.get(id);
      return row && row.user_id === userId ? row : null;
    },
    // Shared-session run access: this suite only exercises owner-scoped and
    // not-found paths, so no run belongs to a live shared session. resolveRunAccess()
    // calls this after the owner lookup misses; returning null yields the expected 404.
    // (The real adapter implements this against the shared_sessions table.)
    async getSharedSessionByRun(_runId: string) {
      return null;
    },
    async listUserRuns(userId: string, filter?: { status?: UserRunRow['status']; limit?: number; offset?: number }) {
      let result = [...runs.values()].filter((r) => r.user_id === userId);
      if (filter?.status) result = result.filter((r) => r.status === filter.status);
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return result.slice(offset, offset + limit);
    },
    async updateUserRunStatus(id: string, userId: string, status: UserRunRow['status']) {
      const row = runs.get(id);
      if (row && row.user_id === userId) {
        runs.set(id, { ...row, status, updated_at: new Date().toISOString() });
      }
    },
    async appendUserRunEvent(ev: UserRunEventRow) {
      const list = events.get(ev.run_id) ?? [];
      const now = new Date().toISOString();
      list.push({ ...ev, created_at: now });
      events.set(ev.run_id, list);
    },
    async listUserRunEvents(runId: string, afterSeq = -1) {
      return (events.get(runId) ?? []).filter((e) => e.sequence > afterSeq);
    },
    async registerDevice() {},
    async removeDevice() {},
    async listDevices() { return []; },
    async getNotificationPrefs() { return null; },
    async upsertNotificationPrefs() {},
    async listModeLabels(surfaceId: string) {
      return modes.filter((m) => m.surface_id === surfaceId);
    },
    async listStarterPrompts(surfaceId: string) {
      return starters.filter((s) => s.surface_id === surfaceId);
    },

    // ── Idempotency ─────────────────────────────────────────────────────────
    async getIdempotencyRecordByKey(key: string) {
      return idempotencyMap.get(key) ?? null;
    },
    async createIdempotencyRecord(rec: { id: string; key: string; result_json: string; expires_at: string }) {
      idempotencyMap.set(rec.key, rec);
    },

    // ── Temporal reminders — no-op stubs ────────────────────────────────────
    async listTemporalRemindersByUserId(_userId: string) { return []; },
    async deleteTemporalReminderById(_reminderId: string, _userId: string) { return false; },

    // ── Everything else is unused in these tests — no-op stubs ─────────────
  } as unknown as DatabaseAdapter & {
    _runs: Map<string, UserRunRow>;
    _events: Map<string, UserRunEventRow[]>;
    _modes: ModeLabel[];
    _starters: StarterPrompt[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH = { userId: 'user-1', tenantId: 'tenant-a', role: 'user' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W9 /api/me routes', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
    registerMeRoutes(router as any, db as any);
  });

  // ── Runs ──────────────────────────────────────────────────────────────────

  describe('POST /api/me/runs', () => {
    it('creates a run and returns 201 with the run record', async () => {
      const res = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ surface: 'web' }), AUTH);
      expect(res.status).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ user_id: 'user-1', status: 'pending', surface: 'web' });
      expect(typeof body.id).toBe('string');
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await router.dispatch('POST', '/api/me/runs', '{}', undefined);
      expect(res.status).toBe(401);
    });

    it('idempotency key returns same run on retry', async () => {
      const headers = { 'idempotency-key': 'idem-42' };
      const res1 = await router.dispatch('POST', '/api/me/runs', '{}', AUTH, headers);
      expect(res1.status).toBe(201);
      const firstId = res1.json().id;

      // Second call: stub returns cached run from idempotency store
      const res2 = await router.dispatch('POST', '/api/me/runs', '{}', AUTH, headers);
      expect(res2.status).toBe(200);
      expect(res2.json().id).toBe(firstId);
    });
  });

  describe('GET /api/me/runs', () => {
    it('lists runs for authenticated user', async () => {
      await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const res = await router.dispatch('GET', '/api/me/runs?limit=10', '{}', AUTH);
      expect(res.status).toBe(200);
      const { runs } = res.json() as { runs: unknown[] };
      expect(runs).toHaveLength(2);
    });

    it('does not return other users runs', async () => {
      await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const other = { ...AUTH, userId: 'user-2' };
      const res = await router.dispatch('GET', '/api/me/runs', '{}', other);
      expect(res.json().runs).toHaveLength(0);
    });
  });

  describe('GET /api/me/runs/:runId', () => {
    it('returns the run record for owner', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      const res = await router.dispatch('GET', `/api/me/runs/${runId}`, '{}', AUTH);
      expect(res.status).toBe(200);
      expect(res.json().id).toBe(runId);
    });

    it('returns 404 for non-existent run', async () => {
      const res = await router.dispatch('GET', '/api/me/runs/does-not-exist', '{}', AUTH);
      expect(res.status).toBe(404);
    });

    it('returns 404 for another user trying to access run', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      const other = { ...AUTH, userId: 'user-99' };
      const res = await router.dispatch('GET', `/api/me/runs/${runId}`, '{}', other);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/me/runs/:runId/cancel', () => {
    it('cancels a pending run', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      const res = await router.dispatch('POST', `/api/me/runs/${runId}/cancel`, '{}', AUTH);
      expect(res.status).toBe(200);
      expect(res.json().status).toBe('cancelled');
    });

    it('returns 409 if run already terminal', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      // cancel once
      await router.dispatch('POST', `/api/me/runs/${runId}/cancel`, '{}', AUTH);
      // cancel again
      const res = await router.dispatch('POST', `/api/me/runs/${runId}/cancel`, '{}', AUTH);
      expect(res.status).toBe(409);
    });

    it('returns 404 for unknown run', async () => {
      const res = await router.dispatch('POST', '/api/me/runs/nope/cancel', '{}', AUTH);
      expect(res.status).toBe(404);
    });
  });

  describe('POST + GET /api/me/runs/:runId/events', () => {
    it('appends a client event and sequence increments', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      const res = await router.dispatch(
        'POST', `/api/me/runs/${runId}/events`,
        JSON.stringify({ kind: 'client.note', payload: { note: 'hello' } }), AUTH,
      );
      expect(res.status).toBe(201);
      expect(res.json().sequence).toBe(0);
    });

    it('GET events returns SSE 200 for terminal run and closes immediately', async () => {
      const created = await router.dispatch('POST', '/api/me/runs', '{}', AUTH);
      const runId = created.json().id as string;
      await router.dispatch('POST', `/api/me/runs/${runId}/cancel`, '{}', AUTH);
      const res = await router.dispatch('GET', `/api/me/runs/${runId}/events`, '{}', AUTH);
      // SSE: 200 with event-stream content type
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });
  });

  // ── Catalog ───────────────────────────────────────────────────────────────

  describe('GET /api/me/catalog', () => {
    it('returns mode entries and starter prompts for a surface', async () => {
      db._modes.push({
        id: 'm1', surface_id: 'web', mode_key: 'assistant', label: 'Assistant',
        description: null, icon: null, is_default: 1, sort_order: 0, enabled: 1,
        metadata: null, created_at: new Date().toISOString(),
      });
      db._starters.push({
        id: 's1', surface_id: 'web', label: 'Help me write', prompt_text: 'Help me write…',
        sort_order: 0, enabled: 1, metadata: null, created_at: new Date().toISOString(),
      });
      const res = await router.dispatch('GET', '/api/me/catalog?surface=web', '{}', AUTH);
      expect(res.status).toBe(200);
      const body = res.json() as any;
      expect(body.surfaceId).toBe('web');
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].label).toBe('Assistant');
      expect(body.entries[0].default).toBe(true);
      expect(body.starterPrompts).toHaveLength(1);
    });

    it('returns empty entries for unknown surface', async () => {
      const res = await router.dispatch('GET', '/api/me/catalog?surface=unknown', '{}', AUTH);
      expect(res.status).toBe(200);
      const body = res.json() as any;
      expect(body.entries).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const res = await router.dispatch('GET', '/api/me/catalog', '{}', undefined);
      expect(res.status).toBe(401);
    });
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  describe('POST /api/me/tasks', () => {
    it('creates an action-item task for the current user', async () => {
      const res = await router.dispatch(
        'POST', '/api/me/tasks',
        JSON.stringify({ title: 'Review PR', provenance: { sourceRef: 'test', createdBy: 'principal' } }),
        AUTH,
      );
      expect(res.status).toBe(201);
      const body = res.json() as any;
      expect(body.title).toBe('Review PR');
      expect(body.type).toBe('action-item');
    });
  });

  describe('POST /api/me/tasks/:taskId/complete', () => {
    it('completes a task', async () => {
      const created = await router.dispatch(
        'POST', '/api/me/tasks',
        JSON.stringify({ title: 'Do thing', provenance: { sourceRef: 'test', createdBy: 'principal' } }),
        AUTH,
      );
      const taskId = created.json().id as string;
      const res = await router.dispatch('POST', `/api/me/tasks/${taskId}/complete`, '{}', AUTH);
      expect(res.status).toBe(200);
      expect(res.json().status).toBe('completed');
    });
  });

  // ── Reminders ─────────────────────────────────────────────────────────────

  describe('POST /api/me/reminders', () => {
    it('creates a one-shot reminder trigger', async () => {
      const fireAt = new Date(Date.now() + 3_600_000).toISOString();
      const res = await router.dispatch(
        'POST', '/api/me/reminders',
        JSON.stringify({ title: 'Stand-up', fireAt }),
        AUTH,
      );
      expect(res.status).toBe(201);
      const body = res.json() as any;
      expect(body.id).toBeTruthy();
      expect(body.target?.kind).toBe('reminder_bus');
    });

    it('returns 400 if neither fireAt nor rrule provided', async () => {
      const res = await router.dispatch('POST', '/api/me/reminders', JSON.stringify({ title: 'oops' }), AUTH);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/me/reminders', () => {
    it('lists reminders created by this user', async () => {
      const fireAt = new Date(Date.now() + 1_000).toISOString();
      await router.dispatch('POST', '/api/me/reminders', JSON.stringify({ label: 'R1', fireAt }), AUTH);
      const res = await router.dispatch('GET', '/api/me/reminders', '{}', AUTH);
      expect(res.status).toBe(200);
      const { reminders } = res.json() as any;
      // Module-level triggerStore persists across tests, so count ≥ 1
      expect(reminders.length).toBeGreaterThanOrEqual(1);
      // label is stored as metadata.label on the Trigger
      expect(reminders.some((r: any) => r.metadata?.['label'] === 'R1')).toBe(true);
    });
  });
});
