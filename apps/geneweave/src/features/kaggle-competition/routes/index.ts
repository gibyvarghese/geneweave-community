// no-raw-fetch: allow (reason: `fetch` in pollRows is a closure parameter, not the global)
/**
 * Kaggle Competition — HTTP route handlers
 *
 * Per-run UUIDv7 isolation: every "Start Competition" click creates a fresh
 * `kgl_competition_run` row, a fresh live-agents mesh keyed by UUIDv7, and a
 * fresh sequence of `kgl_run_step` rows. Subsequent runs of the same
 * competition produce independent flows.
 *
 *   POST   /api/kaggle/competition-runs            — start a new run (Idempotency-Key required)
 *   GET    /api/kaggle/competition-runs            — list runs for tenant
 *   GET    /api/kaggle/competition-runs/:id        — run header + steps
 *   GET    /api/kaggle/competition-runs/:id/events — SSE event stream
 *   POST   /api/kaggle/competition-runs/:id/cancel — abandon a run (idempotent)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import { createDurableIdempotencyStore, type DurableIdempotencyEntry } from '@weaveintel/resilience';
import { liveKaggleAdapter, type KaggleAdapter, type KaggleCredentials } from '../../../kaggle/index.js';
import type { DatabaseAdapter } from '../../../db.js';
import type { KaggleCompetitionRunner } from '../runner.js';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: { userId: string; tenantId?: string | null } | null,
) => Promise<void>;

type JsonHelper = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBodyHelper = (req: IncomingMessage) => Promise<string>;

interface Router {
  get(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
}

const TERMINAL_STATUSES = new Set(['completed', 'abandoned', 'failed']);

function createDbBackedIdempotencyStore(db: DatabaseAdapter) {
  return createDurableIdempotencyStore(
    { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 10_000 },
    {
      async get(key: string) {
        const record = await db.getIdempotencyRecordByKey(key);
        if (!record) return null;
        return {
          result: JSON.parse(record.result_json) as unknown,
          expiresAt: Date.parse(record.expires_at),
        };
      },
      async set(key: string, entry: DurableIdempotencyEntry) {
        await db.createIdempotencyRecord({
          id: newUUIDv7(),
          key,
          result_json: JSON.stringify(entry.result),
          expires_at: new Date(entry.expiresAt).toISOString(),
        });
      },
      async deleteExpired(nowMs: number) {
        await db.deleteExpiredIdempotencyRecords(new Date(nowMs).toISOString());
      },
      async trimOldest(maxEntries: number) {
        await db.trimIdempotencyRecords(maxEntries);
      },
      async clear() {
        await db.clearIdempotencyRecords();
      },
    },
  );
}

function sseFrame(res: ServerResponse, event: string, id: string, data: unknown): void {
  res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSSEKeepalive(res: ServerResponse): NodeJS.Timeout {
  return setInterval(() => { res.write(': ping\n\n'); }, 15_000);
}

async function* pollRows<T extends { id: string }>(
  fetch: (afterId: string | undefined) => Promise<T[]>,
  lastId: string | undefined,
  isTerminal: () => Promise<boolean>,
  pollIntervalMs = 1_000,
  maxWaitMs = 300_000,
): AsyncGenerator<T> {
  const deadline = Date.now() + maxWaitMs;
  let cursor = lastId;
  while (Date.now() < deadline) {
    const rows = await fetch(cursor);
    for (const row of rows) {
      cursor = row.id;
      yield row;
    }
    if (rows.length === 0) {
      if (await isTerminal()) return;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }
}

export function registerKaggleCompetitionRoutes(
  router: Router,
  db: DatabaseAdapter,
  json: JsonHelper,
  readBody: ReadBodyHelper,
  runner?: KaggleCompetitionRunner,
  opts?: { kaggleAdapter?: KaggleAdapter },
): void {
  const iStore = createDbBackedIdempotencyStore(db);
  const adapter: KaggleAdapter = opts?.kaggleAdapter ?? liveKaggleAdapter;

  // ── GET /api/kaggle/competition-runs ───────────────────────────────────
  router.get('/api/kaggle/competition-runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const runs = await db.listKglCompetitionRuns({ tenantId, limit: 50 });
    json(res, 200, { runs });
  }, { auth: true });

  // ── POST /api/kaggle/competition-runs ──────────────────────────────────
  router.post('/api/kaggle/competition-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey) {
      const check = await iStore.check(`kgl-runs:${idempotencyKey}`);
      if (check.isDuplicate) { json(res, 201, check.previousResult); return; }
    }

    let body: { competitionRef?: string; title?: string; objective?: string };
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: 'Invalid JSON body' }); return; }

    const competitionRef = (body.competitionRef ?? '').trim();
    if (!competitionRef) { json(res, 400, { error: 'competitionRef is required' }); return; }

    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const id = newUUIDv7();
    const now = new Date().toISOString();

    const run = await db.createKglCompetitionRun({
      id,
      tenant_id: tenantId,
      submitted_by: auth.userId,
      competition_ref: competitionRef,
      title: body.title?.trim() || competitionRef,
      objective: body.objective?.trim() || null,
      mesh_id: null,
      status: 'queued',
      summary: null,
      started_at: now,
      completed_at: null,
    });

    // Fire-and-forget: provision mesh + seed step ledger
    if (runner) {
      runner.startRun({
        runId: run.id,
        tenantId,
        userId: auth.userId,
        competitionRef,
        title: run.title ?? competitionRef,
        objective: run.objective ?? '',
      }).catch((err: unknown) => {
        console.error('[kaggle] run failed for', run.id, err);
        db.updateKglCompetitionRun(run.id, {
          status: 'failed',
          summary: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
        }).catch(() => {});
      });
    }

    const responseBody = { id: run.id, status: run.status, meshId: run.mesh_id };
    if (idempotencyKey) await iStore.record(`kgl-runs:${idempotencyKey}`, responseBody);
    json(res, 201, responseBody);
  }, { auth: true, csrf: true });

  // ── GET /api/kaggle/competition-runs/:id ───────────────────────────────
  router.get('/api/kaggle/competition-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const run = await db.getKglCompetitionRun(id, tenantId);
    if (!run) { json(res, 404, { error: 'Run not found' }); return; }
    const steps = await db.listKglRunSteps(id);
    json(res, 200, { run, steps });
  }, { auth: true });

  // ── POST /api/kaggle/competition-runs/:id/cancel ───────────────────────
  router.post('/api/kaggle/competition-runs/:id/cancel', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const run = await db.getKglCompetitionRun(id, tenantId);
    if (!run) { json(res, 404, { error: 'Run not found' }); return; }
    if (TERMINAL_STATUSES.has(run.status)) {
      json(res, 200, { id: run.id, status: run.status });
      return;
    }
    await db.updateKglCompetitionRun(id, {
      status: 'abandoned',
      completed_at: new Date().toISOString(),
    });
    await db.appendKglRunEvent({
      id: newUUIDv7(),
      run_id: id,
      step_id: null,
      kind: 'status_change',
      agent_id: null,
      tool_key: null,
      summary: 'Run cancelled by operator.',
      payload_json: null,
    });
    json(res, 200, { id, status: 'abandoned' });
  }, { auth: true, csrf: true });

  // ── GET /api/kaggle/competition-runs/:id/events (SSE) ──────────────────
  router.get('/api/kaggle/competition-runs/:id/events', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const run = await db.getKglCompetitionRun(id, tenantId);
    if (!run) { json(res, 404, { error: 'Run not found' }); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? undefined;
    const ka = startSSEKeepalive(res);

    try {
      const isTerminal = async () => {
        const r = await db.getKglCompetitionRun(id, tenantId);
        return TERMINAL_STATUSES.has(r?.status ?? '');
      };
      for await (const row of pollRows(
        (afterId) => db.listKglRunEvents(id, { afterId, limit: 50 }),
        lastEventId,
        isTerminal,
      )) {
        sseFrame(res, row.kind || 'event', row.id, {
          id: row.id,
          stepId: row.step_id,
          kind: row.kind,
          agentId: row.agent_id,
          toolKey: row.tool_key,
          summary: row.summary,
          payload: row.payload_json ? JSON.parse(row.payload_json) : null,
          createdAt: row.created_at,
        });
      }
      // Emit a final status frame so the UI can transition.
      const finalRun = await db.getKglCompetitionRun(id, tenantId);
      if (finalRun) {
        sseFrame(res, 'run_status', `status-${finalRun.id}-${Date.now()}`, {
          id: finalRun.id,
          status: finalRun.status,
          completedAt: finalRun.completed_at,
        });
      }
    } finally {
      clearInterval(ka);
      res.end();
    }
  }, { auth: true });

  // ── POST /api/kaggle/competitions/discover ─────────────────────────────
  // Pulls one or more pages of active competitions from the live Kaggle API
  // and upserts each into `kaggle_competitions_tracked` so the admin tab
  // reflects the real catalog instead of just the demo seed row.
  router.post('/api/kaggle/competitions/discover', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    let body: { pages?: number; category?: string; search?: string; sortBy?: string; status?: string } = {};
    try {
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw);
    } catch { json(res, 400, { error: 'Invalid JSON body' }); return; }

    const username = process.env['KAGGLE_USERNAME'];
    const key = process.env['KAGGLE_KEY'];
    if (!username || !key) {
      json(res, 412, { error: 'Kaggle credentials missing — set KAGGLE_USERNAME and KAGGLE_KEY in env.' });
      return;
    }
    const creds: KaggleCredentials = { username, key };

    const pages = Math.max(1, Math.min(10, body.pages ?? 1));
    const status = body.status ?? 'watching';
    const now = new Date().toISOString();

    let inserted = 0;
    const competitions: Array<{ ref: string; title: string }> = [];
    try {
      for (let page = 1; page <= pages; page++) {
        const list = await adapter.listCompetitions(creds, {
          page,
          ...(body.category ? { category: body.category } : {}),
          ...(body.search ? { search: body.search } : {}),
          ...(body.sortBy ? { sortBy: body.sortBy } : {}),
        });
        if (list.length === 0) break;
        for (const c of list) {
          const ref = (c.id || '').trim();
          if (!ref) continue;
          await db.upsertKaggleCompetitionTracked({
            id: newUUIDv7(),
            tenant_id: tenantId,
            competition_ref: ref,
            title: c.title ?? ref,
            category: c.category ?? null,
            deadline: c.deadline ?? null,
            reward: c.reward ?? null,
            url: c.url ?? `https://www.kaggle.com/competitions/${ref}`,
            status,
            notes: c.evaluationMetric ? `metric: ${c.evaluationMetric}` : null,
            last_synced_at: now,
          });
          competitions.push({ ref, title: c.title ?? ref });
          inserted++;
        }
      }
    } catch (err) {
      json(res, 502, { error: `Kaggle discovery failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    json(res, 200, { inserted, pages, competitions });
  }, { auth: true, csrf: true });
}
