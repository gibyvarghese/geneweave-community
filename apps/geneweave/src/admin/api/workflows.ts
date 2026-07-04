import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { WorkflowDefRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register workflow admin routes
 *
 * Routes:
 * - GET /api/admin/workflows
 * - GET /api/admin/workflows/:id
 * - POST /api/admin/workflows
 * - PUT /api/admin/workflows/:id
 * - DEL /api/admin/workflows/:id
 */
export function registerWorkflowRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/workflows', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workflows = await db.listWorkflowDefs();
    json(res, 200, { workflows });
  }, { auth: true });

  router.get('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const w = await db.getWorkflowDef(params['id']!);
    if (!w) { json(res, 404, { error: 'Workflow not found' }); return; }
    json(res, 200, { workflow: w });
  }, { auth: true });

  router.post('/api/admin/workflows', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['steps'] || !body['entry_step_id']) { json(res, 400, { error: 'name, steps, and entry_step_id required' }); return; }
    // Pack `output_contract` into metadata JSON under a reserved key so
    // workflow runs can emit typed completion contracts (Phase 4 of the
    // DB-Driven Capability Plan). `rowToWorkflow` in workflow-engine.ts
    // unpacks it on read.
    const baseMetadata = (body['metadata'] && typeof body['metadata'] === 'object') ? (body['metadata'] as Record<string, unknown>) : {};
    const merged = body['output_contract']
      ? { ...baseMetadata, __outputContract: body['output_contract'] }
      : baseMetadata;
    const metadataJson = (Object.keys(merged).length > 0) ? JSON.stringify(merged) : null;
    const id = 'wf-' + newUUIDv7().slice(-8);
    await db.createWorkflowDef({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      version: (body['version'] as string) ?? '1.0',
      steps: JSON.stringify(body['steps']),
      entry_step_id: body['entry_step_id'] as string,
      metadata: metadataJson,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const workflow = await db.getWorkflowDef(id);
    json(res, 201, { workflow });
  }, { auth: true, csrf: true });

  router.put('/api/admin/workflows/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWorkflowDef(params['id']!);
    if (!existing) { json(res, 404, { error: 'Workflow not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['steps'] !== undefined) fields['steps'] = JSON.stringify(body['steps']);
    if (body['entry_step_id'] !== undefined) fields['entry_step_id'] = body['entry_step_id'];
    if (body['metadata'] !== undefined || body['output_contract'] !== undefined) {
      // When the caller patches output_contract WITHOUT metadata, preserve
      // the existing metadata fields and only overlay __outputContract.
      // Otherwise the row's metadata is silently wiped on every contract edit.
      let baseMetadata: Record<string, unknown>;
      if (body['metadata'] !== undefined) {
        baseMetadata = (body['metadata'] && typeof body['metadata'] === 'object')
          ? { ...(body['metadata'] as Record<string, unknown>) }
          : {};
      } else {
        // Preserve existing row metadata (excluding the reserved key, which
        // we're about to rewrite from output_contract).
        const existingMeta = existing.metadata;
        let parsed: Record<string, unknown> = {};
        if (existingMeta && typeof existingMeta === 'string') {
          try { parsed = JSON.parse(existingMeta) as Record<string, unknown>; } catch { parsed = {}; }
        } else if (existingMeta && typeof existingMeta === 'object') {
          parsed = { ...(existingMeta as Record<string, unknown>) };
        }
        delete parsed['__outputContract'];
        baseMetadata = parsed;
      }
      const merged = body['output_contract']
        ? { ...baseMetadata, __outputContract: body['output_contract'] }
        : baseMetadata;
      fields['metadata'] = (Object.keys(merged).length > 0) ? JSON.stringify(merged) : null;
    }
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateWorkflowDef(params['id']!, fields as Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>);
    const workflow = await db.getWorkflowDef(params['id']!);
    json(res, 200, { workflow });
  }, { auth: true, csrf: true });

  router.del('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkflowDef(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
