import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { MemoryGovernanceRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register memory governance admin routes
 */
export function registerMemoryGovernanceRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/memory-governance', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listMemoryGovernance();
    json(res, 200, { 'memory-governance': items });
  }, { auth: true });

  router.get('/api/admin/memory-governance/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getMemoryGovernance(params['id']!);
    if (!c) { json(res, 404, { error: 'Memory governance rule not found' }); return; }
    json(res, 200, { 'memory-governance-rule': c });
  }, { auth: true });

  router.post('/api/admin/memory-governance', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'mgov-' + newUUIDv7().slice(-8);
    await db.createMemoryGovernance({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      memory_types: body['memory_types'] ? (typeof body['memory_types'] === 'string' ? body['memory_types'] as string : JSON.stringify(body['memory_types'])) : '["*"]',
      tenant_id: (body['tenant_id'] as string) ?? null,
      block_patterns: body['block_patterns'] ? (typeof body['block_patterns'] === 'string' ? body['block_patterns'] as string : JSON.stringify(body['block_patterns'])) : '[]',
      redact_patterns: body['redact_patterns'] ? (typeof body['redact_patterns'] === 'string' ? body['redact_patterns'] as string : JSON.stringify(body['redact_patterns'])) : '[]',
      max_age: (body['max_age'] as string) ?? null,
      max_entries: (body['max_entries'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getMemoryGovernance(id);
    json(res, 201, { 'memory-governance-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/memory-governance/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMemoryGovernance(params['id']!);
    if (!existing) { json(res, 404, { error: 'Memory governance rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['memory_types'] !== undefined) fields['memory_types'] = typeof body['memory_types'] === 'string' ? body['memory_types'] : JSON.stringify(body['memory_types']);
    if (body['tenant_id'] !== undefined) fields['tenant_id'] = body['tenant_id'];
    if (body['block_patterns'] !== undefined) fields['block_patterns'] = typeof body['block_patterns'] === 'string' ? body['block_patterns'] : JSON.stringify(body['block_patterns']);
    if (body['redact_patterns'] !== undefined) fields['redact_patterns'] = typeof body['redact_patterns'] === 'string' ? body['redact_patterns'] : JSON.stringify(body['redact_patterns']);
    if (body['max_age'] !== undefined) fields['max_age'] = body['max_age'];
    if (body['max_entries'] !== undefined) fields['max_entries'] = body['max_entries'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateMemoryGovernance(params['id']!, fields as Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>);
    const item = await db.getMemoryGovernance(params['id']!);
    json(res, 200, { 'memory-governance-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/memory-governance/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMemoryGovernance(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
