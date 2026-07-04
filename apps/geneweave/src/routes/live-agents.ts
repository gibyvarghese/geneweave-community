import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { getCancellationBus } from '../live-agents/cancellation-bus.js';
import { getGenericSupervisorHandle } from '../live-agents/generic-supervisor-boot.js';

export function registerLiveAgentRoutes(router: Router, db: DatabaseAdapter): void {

  // ── Live-agent lifecycle ────────────────────────────────────────────────────

  // Start a new live-agent run. Persists to api_live_runs so stop signals
  // survive process restarts and work across multiple replicas.
  router.post('/api/live-agents/runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { agentId?: string; config?: unknown } = {};
    try { if (raw.trim()) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const runId = newUUIDv7();
    const run = await db.createApiLiveRun({
      id: runId,
      user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      agent_id: body.agentId ?? null,
      status: 'running',
      stop_requested: 0,
      config_json: body.config ? JSON.stringify(body.config) : null,
    });
    json(res, 200, { runId: run.id, status: run.status, createdAt: run.created_at });
  }, { auth: true, csrf: true });

  // Get status of a live-agent run.
  router.get('/api/live-agents/runs/:runId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getApiLiveRun(params['runId']!);
    if (!run || run.user_id !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    json(res, 200, {
      runId: run.id,
      status: run.status,
      stopRequested: run.stop_requested === 1,
      agentId: run.agent_id,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    });
  });

  // Stop a live-agent run. Persists stop_requested=1 to DB so agent loops
  // on any replica can detect the signal by calling isApiRunStopped().
  // Phase 4: also fires the in-process RunCancellationBus and calls
  // cancelRun on the generic supervisor so the next tick is skipped
  // immediately without waiting for the next DB poll cycle.
  router.post('/api/live-agents/runs/:runId/stop', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getApiLiveRun(params['runId']!);
    if (!run || run.user_id !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    await db.updateApiLiveRun(run.id, { status: 'stopped', stop_requested: 1 });
    // Phase 4 — in-process cancellation (best-effort, never throws to caller).
    try { getCancellationBus().cancel(run.id); } catch { /* noop */ }
    try { getGenericSupervisorHandle()?.cancelRun(run.id); } catch { /* noop */ }
    json(res, 200, { runId: run.id, status: 'stopped', stopRequested: true });
  }, { auth: true, csrf: true });

  // Resume a live-agent run (idempotent — running runs stay running).
  router.post('/api/live-agents/runs/:runId/resume', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getApiLiveRun(params['runId']!);
    if (!run || run.user_id !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    if (run.status === 'stopped') {
      await db.updateApiLiveRun(run.id, { status: 'running', stop_requested: 0 });
    }
    const updated = await db.getApiLiveRun(run.id);
    json(res, 200, { runId: run.id, status: updated?.status ?? run.status });
  }, { auth: true, csrf: true });

  // List all live-agent runs for the authenticated user.
  router.get('/api/live-agents/runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runs = await db.listUserApiLiveRuns(auth.userId, { limit: 50 });
    json(res, 200, {
      runs: runs.map(r => ({
        runId: r.id,
        status: r.status,
        stopRequested: r.stop_requested === 1,
        agentId: r.agent_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

}

/**
 * Check whether a live-agent run has been stopped. Call at each agent step
 * boundary — if this returns true the agent loop should halt cleanly.
 */
export async function isApiRunStopped(db: DatabaseAdapter, runId: string): Promise<boolean> {
  const run = await db.getApiLiveRun(runId);
  return run !== null && (run.stop_requested === 1 || run.status === 'stopped');
}
