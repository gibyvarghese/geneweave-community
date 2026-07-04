import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerMemoryProceduralRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // List all procedural memories (admin view — across users)
  router.get('/api/admin/procedural-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const items = await db.listAllProceduralMemory({ userId, status, limit, offset });
    json(res, 200, { 'procedural-memory': items });
  }, { auth: true });

  router.get('/api/admin/procedural-memory/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getProceduralMemory(params['id']!);
    if (!item) { json(res, 404, { error: 'Not found' }); return; }
    json(res, 200, { 'procedural-memory-entry': item });
  }, { auth: true });

  // Admin can manually create a procedural memory entry (e.g. to teach the agent a user preference)
  router.post('/api/admin/procedural-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['user_id'] || !body['instruction_delta']) {
      json(res, 400, { error: 'user_id and instruction_delta required' }); return;
    }
    const validStatuses = ['proposed', 'approved', 'rejected', 'applied'];
    const status = validStatuses.includes(body['status'] as string) ? (body['status'] as string) : 'proposed';
    const id = 'proc-' + newUUIDv7().slice(-8);
    await db.createProceduralMemory({
      id,
      user_id: body['user_id'] as string,
      agent_id: (body['agent_id'] as string) ?? 'default',
      instruction_delta: body['instruction_delta'] as string,
      proposed_by: (body['proposed_by'] as string) ?? 'admin',
      status,
      confidence: typeof body['confidence'] === 'number' ? body['confidence'] : 0.8,
      human_task_id: (body['human_task_id'] as string) ?? null,
      applied_at: status === 'applied' ? new Date().toISOString() : null,
    });
    const item = await db.getProceduralMemory(id);
    json(res, 201, { 'procedural-memory-entry': item });
  }, { auth: true, csrf: true });

  // Approve a proposed procedural memory entry
  router.post('/api/admin/procedural-memory/:id/approve', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getProceduralMemory(params['id']!);
    if (!item) { json(res, 404, { error: 'Not found' }); return; }
    if (item.status !== 'proposed') {
      json(res, 409, { error: `Cannot approve entry with status "${item.status}" — only "proposed" entries can be approved` }); return;
    }
    await db.updateProceduralMemoryStatus(params['id']!, 'approved');
    json(res, 200, { ok: true, status: 'approved' });
  }, { auth: true, csrf: true });

  // Apply an approved procedural memory entry
  router.post('/api/admin/procedural-memory/:id/apply', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getProceduralMemory(params['id']!);
    if (!item) { json(res, 404, { error: 'Not found' }); return; }
    if (item.status !== 'approved') {
      json(res, 400, { error: 'Entry must be approved before it can be applied' }); return;
    }
    await db.updateProceduralMemoryStatus(params['id']!, 'applied', new Date().toISOString());
    json(res, 200, { ok: true, status: 'applied' });
  }, { auth: true, csrf: true });

  // Reject a proposed or approved procedural memory entry
  router.post('/api/admin/procedural-memory/:id/reject', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getProceduralMemory(params['id']!);
    if (!item) { json(res, 404, { error: 'Not found' }); return; }
    if (item.status === 'applied') {
      json(res, 409, { error: 'Cannot reject an already-applied procedural memory entry' }); return;
    }
    if (item.status === 'rejected') {
      json(res, 409, { error: 'Entry is already rejected' }); return;
    }
    await db.updateProceduralMemoryStatus(params['id']!, 'rejected');
    json(res, 200, { ok: true, status: 'rejected' });
  }, { auth: true, csrf: true });

  router.del('/api/admin/procedural-memory/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteProceduralMemory(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // Working memory snapshots (read-only admin view)
  router.get('/api/admin/working-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const items = await db.listAllWorkingMemorySnapshots({ userId, limit, offset });
    json(res, 200, { 'working-memory': items });
  }, { auth: true });

  router.del('/api/admin/working-memory/:userId/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkingMemorySnapshot(params['id']!, params['userId']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
