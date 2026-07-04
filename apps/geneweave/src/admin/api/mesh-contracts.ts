/**
 * @weaveintel/geneweave — Phase 4 Mesh Contracts admin routes
 *
 *   GET /api/admin/mesh-contracts
 *   GET /api/admin/mesh-contracts/:id
 *
 * Read-only audit ledger. Rows are written by `DbContractEmitter`
 * (workflow run completion or `target_kind: 'contract'` trigger
 * dispatch). Operators inspect emissions here to debug mesh ↔
 * workflow binding without joining traces.
 */

import type { DatabaseAdapter } from '../../db-types.js';

export interface MeshContractRouterLike {
  get(
    path: string,
    handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void,
    opts?: { auth?: boolean; csrf?: boolean },
  ): void;
}

export interface MeshContractRouteHelpers {
  json: (res: any, status: number, body: unknown) => void;
}

export function registerMeshContractRoutes(
  router: MeshContractRouterLike,
  db: DatabaseAdapter,
  helpers: MeshContractRouteHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/mesh-contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL((req as { url?: string }).url ?? '/', 'http://x');
    const kind = url.searchParams.get('kind') ?? undefined;
    const meshId = url.searchParams.get('meshId') ?? url.searchParams.get('mesh_id') ?? undefined;
    const workflowRunId =
      url.searchParams.get('workflowRunId') ??
      url.searchParams.get('workflow_run_id') ??
      undefined;
    const after = url.searchParams.get('after') ?? undefined;
    const before = url.searchParams.get('before') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const rows = await db.listMeshContracts({
      ...(kind ? { kind } : {}),
      ...(meshId ? { meshId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(after ? { after } : {}),
      ...(before ? { before } : {}),
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    json(res, 200, { contracts: rows });
  }, { auth: true });

  router.get('/api/admin/mesh-contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing id' }); return; }
    const row = await db.getMeshContract(id);
    if (!row) { json(res, 404, { error: 'Not found' }); return; }
    json(res, 200, row);
  }, { auth: true });
}
