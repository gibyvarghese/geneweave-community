/**
 * W9b SP3 tests — /api/me/runs executor + live SSE fan-out
 *
 * Uses an in-memory DatabaseAdapter stub + a controllable stub run-agent so
 * no real SQLite or LLM is needed. Covers the SP3 contracts:
 *   - create → executor emits run.started … run.completed (monotonic, gap-free)
 *   - an attached SSE stream receives a live post-attach event (no reconnect)
 *   - GET ?after=<seq> resumes gap-free + duplicate-free (resumable contract)
 *   - cancel halts the executor cooperatively (terminal run.cancelled, no more output)
 *   - idempotent create does not double-dispatch
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerMeRoutes } from './me.js';
import { MeRunExecutor, type MeRunAgent, type MeRunEmitter } from '../me-run-executor.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { UserRunRow, UserRunEventRow } from '../db-types/adapter-me.js';

// ---------------------------------------------------------------------------
// Router + response harness (streaming-aware)
// ---------------------------------------------------------------------------

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

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
  let ended = false;
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  return {
    writeHead(code: number, hdrs?: Record<string, string>) { statusCode = code; if (hdrs) Object.assign(headers, hdrs); },
    end(data?: string) { if (data !== undefined) body = data; ended = true; },
    write(chunk: string) { if (ended) return false; writes.push(chunk); return true; },
    json() { return JSON.parse(body); },
    get status() { return statusCode; },
    get raw() { return body; },
    get written() { return writes; },
    get writableEnded() { return ended; },
    get destroyed() { return false; },
    /** Parse the SSE data frames into envelopes. A frame may carry `id:`/`retry:`
     *  lines before its `data:` line (Collaboration Phase 6 resumable SSE), so
     *  scan every line of each write rather than assuming `data:` is first. */
    envelopes() {
      const out: unknown[] = [];
      for (const w of writes) {
        for (const line of w.split('\n')) {
          if (line.startsWith('data: ')) {
            const payload = line.slice('data: '.length).trim();
            if (payload) out.push(JSON.parse(payload));
          }
        }
      }
      return out;
    },
  };
}

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) => (path: string, handler: Handler) => routes.push({ method, path, handler });
  const socketCloseHandlers: Array<() => void> = [];
  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    put: addRoute('PUT'),
    del: addRoute('DELETE'),
    add: addRoute('ANY'),
    socketCloseHandlers,
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
        socket: { on: (ev: string, cb: () => void) => { if (ev === 'close') socketCloseHandlers.push(cb); } },
        resume: () => {},
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
    closeAllSockets() { for (const cb of socketCloseHandlers) cb(); },
  };
}

// ---------------------------------------------------------------------------
// In-memory DB stub
// ---------------------------------------------------------------------------

function buildDb() {
  const runs = new Map<string, UserRunRow>();
  const events = new Map<string, UserRunEventRow[]>();
  const idem = new Map<string, any>();
  return {
    _runs: runs,
    _events: events,
    async createUserRun(run: any) {
      const now = new Date().toISOString();
      runs.set(run.id, {
        id: run.id, user_id: run.user_id, tenant_id: run.tenant_id ?? null,
        status: run.status, surface: run.surface ?? null, metadata: run.metadata ?? null,
        created_at: now, updated_at: now,
      });
    },
    async getUserRun(id: string, userId: string) {
      const r = runs.get(id);
      return r && r.user_id === userId ? r : null;
    },
    async listUserRuns(userId: string) { return [...runs.values()].filter((r) => r.user_id === userId); },
    async updateUserRunStatus(id: string, userId: string, status: UserRunRow['status']) {
      const r = runs.get(id);
      if (r && r.user_id === userId) runs.set(id, { ...r, status, updated_at: new Date().toISOString() });
    },
    async appendUserRunEvent(ev: UserRunEventRow) {
      const list = events.get(ev.run_id) ?? [];
      list.push({ ...ev, created_at: new Date().toISOString() });
      events.set(ev.run_id, list);
    },
    async listUserRunEvents(runId: string, afterSeq = -1) {
      return (events.get(runId) ?? []).filter((e) => e.sequence > afterSeq);
    },
    async listModeLabels() { return []; },
    async listStarterPrompts() { return []; },
    async getIdempotencyRecordByKey(key: string) { return idem.get(key) ?? null; },
    async createIdempotencyRecord(rec: any) { idem.set(rec.key, rec); },
  } as unknown as DatabaseAdapter & { _runs: Map<string, UserRunRow>; _events: Map<string, UserRunEventRow[]> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH = { userId: 'user-1', tenantId: 'tenant-a', persona: 'tenant_user', role: 'user' };

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A run-agent the test can release step-by-step. */
function gatedAgent() {
  let armReady!: () => void;
  const firstEmitted = new Promise<void>((r) => { armReady = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let emitterRef: MeRunEmitter | undefined;
  const agent: MeRunAgent = async (_args, emit) => {
    emitterRef = emit;
    await emit.text('A');
    armReady();
    await gate;
    await emit.text('B');
  };
  return { agent, firstEmitted, release: () => release(), get emitter() { return emitterRef; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W9b SP3 /api/me/runs executor + live SSE fan-out', () => {
  let router: ReturnType<typeof buildRouter>;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    router = buildRouter();
    db = buildDb();
  });

  it('create dispatches the executor → run.started … run.completed (monotonic, gap-free)', async () => {
    const agent: MeRunAgent = async (_args, emit) => {
      await emit.text('Hello');
      await emit.text(' world');
    };
    const exec = new MeRunExecutor({ db, runAgent: agent });
    registerMeRoutes(router as any, db as any, { runExecutor: exec });

    const created = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH);
    expect(created.status).toBe(201);
    const runId = created.json().id;

    await waitUntil(() => (db._events.get(runId)?.some((e) => e.kind === 'run.completed')) ?? false);

    const evs = db._events.get(runId)!;
    expect(evs.map((e) => e.kind)).toEqual(['run.started', 'text.delta', 'text.delta', 'run.completed']);
    // sequences are gap-free + monotonic
    expect(evs.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    const run = await db.getUserRun(runId, AUTH.userId);
    expect(run?.status).toBe('completed');
  });

  it('an attached SSE stream receives a live post-attach event without reconnecting', async () => {
    const g = gatedAgent();
    const exec = new MeRunExecutor({ db, runAgent: g.agent });
    registerMeRoutes(router as any, db as any, { runExecutor: exec });

    const created = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH);
    const runId = created.json().id;

    // Wait until run.started(0) + text 'A'(1) are persisted, then attach after=1.
    await g.firstEmitted;
    await waitUntil(() => (db._events.get(runId)?.length ?? 0) >= 2);

    const sse = await router.dispatch('GET', `/api/me/runs/${runId}/events?after=1`, '{}', AUTH);
    // Replay after=1 yields nothing; the stream is now live-tailing.
    expect(sse.envelopes()).toHaveLength(0);

    // Release the agent → text 'B'(2) + run.completed(3) appended + broadcast live.
    g.release();
    await waitUntil(() => sse.envelopes().some((e: any) => e.kind === 'run.completed'));

    const live = sse.envelopes();
    expect(live.map((e: any) => e.sequence)).toEqual([2, 3]);
    expect(live.find((e: any) => e.sequence === 2)).toMatchObject({ kind: 'text.delta', payload: { delta: 'B' } });
    expect(sse.writableEnded).toBe(true); // terminal event closed the stream

    router.closeAllSockets();
  });

  it('GET ?after=<seq> resumes gap-free and duplicate-free on a terminal run', async () => {
    const agent: MeRunAgent = async (_args, emit) => {
      await emit.text('one');
      await emit.text('two');
    };
    const exec = new MeRunExecutor({ db, runAgent: agent });
    registerMeRoutes(router as any, db as any, { runExecutor: exec });

    const created = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH);
    const runId = created.json().id;
    await waitUntil(() => (db._events.get(runId)?.some((e) => e.kind === 'run.completed')) ?? false);

    // Resume from sequence 1 — must receive only 2 and 3, in order, no dupes.
    const sse = await router.dispatch('GET', `/api/me/runs/${runId}/events?after=1`, '{}', AUTH);
    const envs = sse.envelopes();
    expect(envs.map((e: any) => e.sequence)).toEqual([2, 3]);
    expect(sse.writableEnded).toBe(true); // terminal run closes after replay
  });

  it('cancel halts the executor cooperatively (run.cancelled, no further output)', async () => {
    const g = gatedAgent();
    const exec = new MeRunExecutor({ db, runAgent: g.agent });
    registerMeRoutes(router as any, db as any, { runExecutor: exec });

    const created = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH);
    const runId = created.json().id;
    await g.firstEmitted; // run.started(0) + 'A'(1) persisted, agent blocked on gate

    const cancelRes = await router.dispatch('POST', `/api/me/runs/${runId}/cancel`, '{}', AUTH);
    expect(cancelRes.status).toBe(200);

    // Release the gate — the agent's post-cancel emit('B') must be dropped.
    g.release();
    await waitUntil(() => (db._events.get(runId)?.some((e) => e.kind === 'run.cancelled')) ?? false);

    const evs = db._events.get(runId)!;
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain('run.cancelled');
    expect(kinds.filter((k) => k === 'run.completed')).toHaveLength(0);
    // Exactly one terminal event.
    expect(kinds.filter((k) => k === 'run.cancelled')).toHaveLength(1);
    // 'B' (a second text.delta) was emitted after cancel → dropped.
    expect(kinds.filter((k) => k === 'text.delta')).toHaveLength(1);

    const run = await db.getUserRun(runId, AUTH.userId);
    expect(run?.status).toBe('cancelled');
  });

  it('idempotent create returns the same run without double-dispatching', async () => {
    let dispatches = 0;
    const agent: MeRunAgent = async (_args, emit) => { dispatches++; await emit.text('x'); };
    const exec = new MeRunExecutor({ db, runAgent: agent });
    registerMeRoutes(router as any, db as any, { runExecutor: exec });

    const headers = { 'idempotency-key': 'idem-sp3' };
    const r1 = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH, headers);
    const id1 = r1.json().id;
    await waitUntil(() => (db._events.get(id1)?.some((e) => e.kind === 'run.completed')) ?? false);

    const r2 = await router.dispatch('POST', '/api/me/runs', JSON.stringify({ input: { text: 'hi' } }), AUTH, headers);
    expect(r2.status).toBe(200);
    expect(r2.json().id).toBe(id1);
    // Second create returns the cached run; the run already completed once.
    expect(dispatches).toBe(1);
  });
});
