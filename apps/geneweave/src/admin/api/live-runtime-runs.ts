/**
 * Phase M22 — DB-Driven Live-Agents Runtime: per-mesh runs ledger.
 *
 * Generic replacement for `kgl_competition_runs` / `kgl_run_step` /
 * `kgl_run_event`. A "run" is one campaign inside a mesh (a Kaggle
 * competition pass, an inbox triage pass, a code-review queue).
 *
 *   - live_runs        (mutable header — status, label, summary)
 *   - live_run_steps   (mutable per-agent progress rows)
 *   - live_run_events  (append-only event log — read-only via this API)
 *
 * Run events are admin-read-only: producers append via the runtime layer.
 */
import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import type { LiveRunRow, LiveRunStepRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

const RUN_BASE   = '/api/admin/live-runs';
const STEP_BASE  = '/api/admin/live-run-steps';
const EVENT_BASE = '/api/admin/live-run-events';

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

// ─── live_runs ─────────────────────────────────────────────────────────────

export function registerLiveRunRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(RUN_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const meshId   = url.searchParams.get('mesh_id')   ?? undefined;
    const tenantId = url.searchParams.get('tenant_id') ?? undefined;
    const status   = url.searchParams.get('status')    ?? undefined;
    const limitStr = url.searchParams.get('limit');
    const items = await db.listLiveRuns({
      ...(meshId   ? { meshId }   : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(status   ? { status }   : {}),
      ...(limitStr ? { limit: Number(limitStr) } : {}),
    });
    json(res, 200, { 'live-runs': items });
  }, { auth: true });

  router.get(`${RUN_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveRun(params['id']!);
    if (!item) { json(res, 404, { error: 'Live run not found' }); return; }
    json(res, 200, { 'live-run': item });
  }, { auth: true });

  router.post(RUN_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['mesh_id']) { json(res, 400, { error: 'mesh_id required' }); return; }
    if (!body['run_key']) { json(res, 400, { error: 'run_key required' }); return; }
    const row: Omit<LiveRunRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      mesh_id: String(body['mesh_id']),
      tenant_id: strOrNull(body['tenant_id']),
      run_key: String(body['run_key']),
      label: strOrNull(body['label']),
      status: String(body['status'] ?? 'RUNNING'),
      stop_requested: 0,
      started_at: String(body['started_at'] ?? new Date().toISOString()),
      completed_at: strOrNull(body['completed_at']),
      summary: strOrNull(body['summary']),
      context_json: strOrNull(body['context_json']),
    };
    const created = await db.createLiveRun(row);
    json(res, 201, { 'live-run': created });
  }, { auth: true, csrf: true });

  router.put(`${RUN_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveRun(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live run not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveRunRow, 'id' | 'mesh_id' | 'created_at'>> = {};
    if (body['tenant_id']    !== undefined) patch.tenant_id    = strOrNull(body['tenant_id']);
    if (body['run_key']      !== undefined) patch.run_key      = String(body['run_key']);
    if (body['label']        !== undefined) patch.label        = strOrNull(body['label']);
    if (body['status']       !== undefined) patch.status       = String(body['status']);
    if (body['started_at']   !== undefined) patch.started_at   = String(body['started_at']);
    if (body['completed_at'] !== undefined) patch.completed_at = strOrNull(body['completed_at']);
    if (body['summary']      !== undefined) patch.summary      = strOrNull(body['summary']);
    if (body['context_json'] !== undefined) patch.context_json = strOrNull(body['context_json']);
    await db.updateLiveRun(params['id']!, patch);
    const item = await db.getLiveRun(params['id']!);
    json(res, 200, { 'live-run': item });
  }, { auth: true, csrf: true });

  router.del(`${RUN_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_run_steps ────────────────────────────────────────────────────────

export function registerLiveRunStepRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(STEP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const runId   = url.searchParams.get('run_id')   ?? undefined;
    const meshId  = url.searchParams.get('mesh_id')  ?? undefined;
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    const items = await db.listLiveRunSteps({
      ...(runId   ? { runId }   : {}),
      ...(meshId  ? { meshId }  : {}),
      ...(agentId ? { agentId } : {}),
    });
    json(res, 200, { 'live-run-steps': items });
  }, { auth: true });

  router.get(`${STEP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveRunStep(params['id']!);
    if (!item) { json(res, 404, { error: 'Live run step not found' }); return; }
    json(res, 200, { 'live-run-step': item });
  }, { auth: true });

  router.post(STEP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    for (const k of ['run_id', 'mesh_id', 'role_key']) {
      if (!body[k]) { json(res, 400, { error: `${k} required` }); return; }
    }
    const row: Omit<LiveRunStepRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      run_id: String(body['run_id']),
      mesh_id: String(body['mesh_id']),
      agent_id: strOrNull(body['agent_id']),
      role_key: String(body['role_key']),
      status: String(body['status'] ?? 'PENDING'),
      started_at: strOrNull(body['started_at']),
      completed_at: strOrNull(body['completed_at']),
      summary: strOrNull(body['summary']),
      payload_json: strOrNull(body['payload_json']),
    };
    const created = await db.createLiveRunStep(row);
    json(res, 201, { 'live-run-step': created });
  }, { auth: true, csrf: true });

  router.put(`${STEP_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveRunStep(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live run step not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveRunStepRow, 'id' | 'run_id' | 'mesh_id' | 'created_at'>> = {};
    if (body['agent_id']     !== undefined) patch.agent_id     = strOrNull(body['agent_id']);
    if (body['role_key']     !== undefined) patch.role_key     = String(body['role_key']);
    if (body['status']       !== undefined) patch.status       = String(body['status']);
    if (body['started_at']   !== undefined) patch.started_at   = strOrNull(body['started_at']);
    if (body['completed_at'] !== undefined) patch.completed_at = strOrNull(body['completed_at']);
    if (body['summary']      !== undefined) patch.summary      = strOrNull(body['summary']);
    if (body['payload_json'] !== undefined) patch.payload_json = strOrNull(body['payload_json']);
    await db.updateLiveRunStep(params['id']!, patch);
    const item = await db.getLiveRunStep(params['id']!);
    json(res, 200, { 'live-run-step': item });
  }, { auth: true, csrf: true });

  router.del(`${STEP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveRunStep(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_run_events (read-only via admin) ─────────────────────────────────

export function registerLiveRunEventRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get(EVENT_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const runId    = url.searchParams.get('run_id')   ?? undefined;
    const afterId  = url.searchParams.get('after_id') ?? undefined;
    const limitStr = url.searchParams.get('limit');
    const items = await db.listLiveRunEvents({
      ...(runId   ? { runId }   : {}),
      ...(afterId ? { afterId } : {}),
      ...(limitStr ? { limit: Number(limitStr) } : {}),
    });
    json(res, 200, { 'live-run-events': items });
  }, { auth: true });

  router.get(`${EVENT_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveRunEvent(params['id']!);
    if (!item) { json(res, 404, { error: 'Live run event not found' }); return; }
    json(res, 200, { 'live-run-event': item });
  }, { auth: true });
}
