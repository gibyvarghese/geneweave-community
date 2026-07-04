/**
 * W9b Gap 3 tests — notification wiring.
 *
 * Covers the preference-backed SuppressionPolicy (master toggle, category
 * allow-list, quiet hours in stored timezone, fail-closed on error), the hub
 * lifecycle helpers (detached-run gating, actionable task priority/actions,
 * reminder deep link) with an in-memory recording channel, and the
 * idempotent POST /api/me/notifications/actions route.
 *
 * No real SQLite, no network: channels and targets are injected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import type { NotificationChannel, NotificationMessage, ChannelTarget, NotificationDelivery } from '@weaveintel/core';
import { createChannelRegistry, createMemoryTargetStore } from '@weaveintel/notifications';
import {
  createPrefsSuppressionPolicy,
  createNotificationsHub,
} from '../notifications-wiring.js';
import { registerMeRoutes } from './me.js';
import { createActionItem } from '@weaveintel/human-tasks';
import type { DatabaseAdapter } from '../db-types.js';
import type { NotificationPrefsRow, UserRunRow } from '../db-types/adapter-me.js';
import type { AuthContext } from '../auth.js';

const GLOBAL = '__global__';

// ── Recording channel ─────────────────────────────────────────────────────────

function recordingChannel(id = 'rec') {
  const sent: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    id,
    capabilities: new Set(),
    async send(_ctx, msg: NotificationMessage, _t: ChannelTarget): Promise<NotificationDelivery> {
      sent.push(msg);
      return { channelId: id, messageId: msg.id, status: 'sent' };
    },
  };
  return { channel, sent };
}

async function hubWithRecorder(db: Pick<DatabaseAdapter, 'getNotificationPrefs'>, prefsSuppression = false) {
  const { channel, sent } = recordingChannel();
  const channels = createChannelRegistry();
  channels.register(channel);
  const targets = createMemoryTargetStore();
  const hub = createNotificationsHub({
    db: db as DatabaseAdapter,
    channels,
    targets,
    ...(prefsSuppression ? {} : { suppression: { async shouldSuppress() { return false; } } }),
  });
  return { hub, sent, targets };
}

function prefs(over: Partial<NotificationPrefsRow> = {}): NotificationPrefsRow {
  return {
    id: 'p1', user_id: 'u1', enabled: 1, categories: '[]', quiet_hours: null,
    timezone: null, created_at: '', updated_at: '', ...over,
  };
}

// ── SuppressionPolicy ──────────────────────────────────────────────────────────

describe('W9b Gap 3 — preference suppression policy', () => {
  const ctx = weaveContext({});
  const sc = (category: string) => ({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', category });

  it('allows when no preferences are stored', async () => {
    const pol = createPrefsSuppressionPolicy({ async getNotificationPrefs() { return null; } });
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(false);
  });

  it('suppresses everything when the master toggle is off', async () => {
    const pol = createPrefsSuppressionPolicy({ async getNotificationPrefs() { return prefs({ enabled: 0 }); } });
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(true);
  });

  it('suppresses categories outside a non-empty allow-list', async () => {
    const pol = createPrefsSuppressionPolicy({ async getNotificationPrefs() { return prefs({ categories: '["task"]' }); } });
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(true);
    expect(await pol.shouldSuppress(ctx, sc('task'))).toBe(false);
  });

  it('suppresses inside quiet hours evaluated in the stored timezone', async () => {
    // 23:00-07:00 in Pacific/Auckland; pick a UTC instant that is 00:00 NZ.
    // NZST = UTC+12 (no DST on this date) → 2025-06-01T12:00:00Z == 2025-06-02T00:00 NZ.
    const now = () => new Date('2025-06-01T12:00:00Z');
    const pol = createPrefsSuppressionPolicy(
      { async getNotificationPrefs() { return prefs({ quiet_hours: '23:00-07:00', timezone: 'Pacific/Auckland' }); } },
      { now },
    );
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(true);
  });

  it('allows outside quiet hours', async () => {
    // 2025-06-01T00:00:00Z == 12:00 NZ → outside 23:00-07:00.
    const now = () => new Date('2025-06-01T00:00:00Z');
    const pol = createPrefsSuppressionPolicy(
      { async getNotificationPrefs() { return prefs({ quiet_hours: '23:00-07:00', timezone: 'Pacific/Auckland' }); } },
      { now },
    );
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(false);
  });

  it('fails closed (suppresses) when preference resolution throws', async () => {
    const pol = createPrefsSuppressionPolicy({ async getNotificationPrefs() { throw new Error('db down'); } });
    expect(await pol.shouldSuppress(ctx, sc('run'))).toBe(true);
  });
});

// ── Hub lifecycle helpers ────────────────────────────────────────────────────

describe('W9b Gap 3 — hub lifecycle', () => {
  const db = { async getNotificationPrefs() { return null; } } as Pick<DatabaseAdapter, 'getNotificationPrefs'>;

  function run(over: Partial<UserRunRow> = {}): UserRunRow {
    return {
      id: 'run-1', user_id: 'u1', tenant_id: null, status: 'completed',
      surface: null, metadata: null, created_at: '', updated_at: '', ...over,
    };
  }

  it('does NOT notify when a run is attached (live subscriber)', async () => {
    const { hub, sent, targets } = await hubWithRecorder(db);
    await targets.upsert({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', target: { kind: 'rec', address: 'a' } });
    const result = await hub.notifyRunTerminal(run(), { attached: true });
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('notifies the owner when a run is detached, with an opaque deep link', async () => {
    const { hub, sent, targets } = await hubWithRecorder(db);
    await targets.upsert({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', target: { kind: 'rec', address: 'a' } });
    const result = await hub.notifyRunTerminal(run(), { attached: false });
    expect(result?.deliveries).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe('run');
    expect(sent[0]!.deepLink).toBe('geneweave://run/run-1');
    expect(sent[0]!.deepLink).not.toContain('u1'); // no principal in URL
  });

  it('actionable task delivers high priority with approve/deny actions', async () => {
    const { hub, sent, targets } = await hubWithRecorder(db);
    await targets.upsert({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', target: { kind: 'rec', address: 'a' } });
    await hub.notifyTask({ id: 't-1', assignee: 'u1', title: 'Approve deploy' }, { actionable: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe('high');
    expect(sent[0]!.actions?.map((a) => a.id)).toEqual(['approve', 'deny']);
    expect(sent[0]!.deepLink).toBe('geneweave://task/t-1');
  });

  it('non-actionable task delivers normal priority without actions', async () => {
    const { hub, sent, targets } = await hubWithRecorder(db);
    await targets.upsert({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', target: { kind: 'rec', address: 'a' } });
    await hub.notifyTask({ id: 't-2', assignee: 'u1', title: 'FYI' });
    expect(sent[0]!.priority).toBe('normal');
    expect(sent[0]!.actions).toBeUndefined();
  });

  it('reminder due notifies the owner', async () => {
    const { hub, sent, targets } = await hubWithRecorder(db);
    await targets.upsert({ tenantId: GLOBAL, principalId: 'u1', channelId: 'rec', target: { kind: 'rec', address: 'a' } });
    await hub.notifyReminderDue({ id: 'rem-1', ownerPrincipalId: 'u1', label: 'Standup' });
    expect(sent[0]!.category).toBe('reminder');
    expect(sent[0]!.deepLink).toBe('geneweave://reminder/rem-1');
  });
});

// ── Actions route ──────────────────────────────────────────────────────────────

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) => (path: string, handler: Handler) => routes.push({ method, path, handler });
  return {
    get: addRoute('GET'), post: addRoute('POST'), put: addRoute('PUT'), del: addRoute('DELETE'),
    add: (method: string, path: string, handler: Handler) => routes.push({ method, path, handler }),
    routes,
    async dispatch(method: string, path: string, body = '{}', auth?: any) {
      const entry = routes.find((r) => r.method === method && (r.path === path || matchPath(r.path, path) !== null));
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const params = matchPath(entry.path, path) ?? {};
      const res = buildResponse();
      const bodyBuf = Buffer.from(body);
      const listeners: Record<string, ((...a: any[]) => void)[]> = {};
      const req = {
        url: path, headers: {}, socket: { on: vi.fn() }, resume: vi.fn(),
        on(event: string, cb: (...a: any[]) => void) {
          (listeners[event] = listeners[event] ?? []).push(cb);
          if (event === 'end') Promise.resolve().then(() => {
            for (const l of listeners['data'] ?? []) l(bodyBuf);
            for (const l of listeners['end'] ?? []) l();
          });
          return req;
        },
      };
      await entry.handler(req, res, params, auth);
      return res;
    },
  };
}

function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const p = pattern.split('/'); const a = actual.split('?')[0]!.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = a[i]!;
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

function buildResponse() {
  let statusCode = 0; let body = '';
  return {
    writeHead(code: number, _h?: Record<string, string>) { statusCode = code; },
    end(data?: string) { body = data ?? ''; }, write() {},
    json() { return JSON.parse(body || '{}'); },
    get status() { return statusCode; },
  };
}

function authFor(userId: string): AuthContext {
  return { userId, email: `${userId}@x.test`, sessionId: 's', csrfToken: 'c', persona: 'tenant_user', tenantId: 't1' } as AuthContext;
}

// Minimal db stub — actions route only touches the in-memory task repo, but
// registerMeRoutes constructs a default catalog resolver, so stub those reads.
function stubDb() {
  return {
    async listModeLabels() { return []; },
    async listLiveAgents() { return []; },
    async listModelPricing() { return []; },
    async listSkills() { return []; },
    async listStarterPrompts() { return []; },
  } as unknown as DatabaseAdapter;
}

describe('W9b Gap 3 — POST /api/me/notifications/actions', () => {
  let router: ReturnType<typeof buildRouter>;

  beforeEach(() => {
    router = buildRouter();
    registerMeRoutes(router as any, stubDb());
  });

  async function createTask(assignee: string): Promise<string> {
    const res = await router.dispatch('POST', '/api/me/tasks',
      JSON.stringify({ title: 'Approve', provenance: { createdBy: 'principal', sourceRef: 'api' } }), authFor(assignee));
    return (res.json() as any).id as string;
  }

  it('401 without auth', async () => {
    const res = await router.dispatch('POST', '/api/me/notifications/actions', '{}', undefined);
    expect(res.status).toBe(401);
  });

  it('400 on missing/invalid actionId', async () => {
    const id = await createTask('u1');
    const res = await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'maybe' }), authFor('u1'));
    expect(res.status).toBe(400);
  });

  it('approve resolves the task (completed)', async () => {
    const id = await createTask('u1');
    const res = await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'approve' }), authFor('u1'));
    expect(res.status).toBe(200);
    const body = res.json() as any;
    expect(body.resolved).toBe(true);
    expect(body.status).toBe('completed');
  });

  it('is idempotent — repeat returns alreadyResolved', async () => {
    const id = await createTask('u1');
    await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'approve' }), authFor('u1'));
    const res2 = await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'approve' }), authFor('u1'));
    expect(res2.status).toBe(200);
    expect((res2.json() as any).alreadyResolved).toBe(true);
  });

  it('deny rejects the task', async () => {
    const id = await createTask('u1');
    const res = await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'deny' }), authFor('u1'));
    expect((res.json() as any).status).toBe('rejected');
  });

  it('hides cross-principal tasks behind a 404', async () => {
    const id = await createTask('owner');
    const res = await router.dispatch('POST', '/api/me/notifications/actions', JSON.stringify({ taskId: id, actionId: 'approve' }), authFor('intruder'));
    expect(res.status).toBe(404);
  });
});
