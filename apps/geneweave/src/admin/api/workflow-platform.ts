/**
 * @weaveintel/geneweave — Workflow Platform Phase 1 admin routes
 *
 * Two new endpoints sitting alongside the existing
 * `/api/admin/workflows` CRUD:
 *
 *   GET  /api/admin/workflow-handler-kinds
 *        → list rows from `workflow_handler_kinds` so the admin UI can
 *          render handler-kind dropdowns. Read-only catalog; rows are
 *          synced from `@weaveintel/workflows` HandlerResolverRegistry
 *          at startup.
 *
 *   POST /api/admin/workflows/:id/run
 *        → kick a run of the named definition through the singleton
 *          DefaultWorkflowEngine. Body: `{ variables?: Record<string,
 *          unknown>, runOnce?: boolean }`. Returns `{ runId, run }`
 *          with the final state when `runOnce !== true`, or the
 *          paused-at-pending state when single-tick mode is requested.
 *
 * Both routes require auth and live on the direct router (not
 * `adminRouter`) so they can opt out of the permission gate when the
 * caller has no workflow engine wired (test boots).
 */

import type { DatabaseAdapter } from '../../db.js';
import type { WorkflowEngineHandle } from '../../workflow-engine.js';

export interface WorkflowPlatformRouterLike {
  get(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export interface WorkflowPlatformHelpers {
  json: (res: any, status: number, body: unknown) => void;
  readBody: (req: any) => Promise<string>;
}

export function registerWorkflowPlatformRoutes(
  router: WorkflowPlatformRouterLike,
  db: DatabaseAdapter,
  helpers: WorkflowPlatformHelpers,
  workflowEngine: WorkflowEngineHandle | undefined,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/workflow-handler-kinds', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listWorkflowHandlerKinds();
    json(res, 200, { kinds: rows });
  }, { auth: true });

  router.post('/api/admin/workflows/:id/run', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!workflowEngine) {
      json(res, 503, { error: 'Workflow engine not wired in this server boot' });
      return;
    }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing workflow id' }); return; }
    let body: { variables?: Record<string, unknown>; runOnce?: boolean } = {};
    try {
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    try {
      const run = await workflowEngine.engine.startRun(id, body.variables ?? {});
      if (body.runOnce) {
        const ticked = await workflowEngine.engine.tickRun(run.id);
        json(res, 201, { runId: run.id, run: ticked });
        return;
      }
      // Default: drive the run to terminal status (or hit the engine's
      // built-in maxSteps fail-safe). Engine.startRun already executes
      // synchronously to completion in DefaultWorkflowEngine.
      json(res, 201, { runId: run.id, run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: 'Workflow run failed', detail: message });
    }
  }, { auth: true, csrf: true });
}
