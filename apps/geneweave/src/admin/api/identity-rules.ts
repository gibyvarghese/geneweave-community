import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { IdentityRuleRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register identity rule admin routes
 */
export function registerIdentityRuleRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/identity-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listIdentityRules();
    json(res, 200, { 'identity-rules': items });
  }, { auth: true });

  router.get('/api/admin/identity-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getIdentityRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Identity rule not found' }); return; }
    json(res, 200, { 'identity-rule': c });
  }, { auth: true });

  router.post('/api/admin/identity-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'ident-' + newUUIDv7().slice(-8);
    await db.createIdentityRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      resource: (body['resource'] as string) ?? '*',
      action: (body['action'] as string) ?? '*',
      roles: body['roles'] ? (typeof body['roles'] === 'string' ? body['roles'] as string : JSON.stringify(body['roles'])) : '["*"]',
      scopes: body['scopes'] ? (typeof body['scopes'] === 'string' ? body['scopes'] as string : JSON.stringify(body['scopes'])) : '["*"]',
      result: (body['result'] as string) ?? 'allow',
      priority: (body['priority'] as number) ?? 100,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getIdentityRule(id);
    json(res, 201, { 'identity-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/identity-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getIdentityRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Identity rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['resource'] !== undefined) fields['resource'] = body['resource'];
    if (body['action'] !== undefined) fields['action'] = body['action'];
    if (body['roles'] !== undefined) fields['roles'] = typeof body['roles'] === 'string' ? body['roles'] : JSON.stringify(body['roles']);
    if (body['scopes'] !== undefined) fields['scopes'] = typeof body['scopes'] === 'string' ? body['scopes'] : JSON.stringify(body['scopes']);
    if (body['result'] !== undefined) fields['result'] = body['result'];
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateIdentityRule(params['id']!, fields as Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>);
    const item = await db.getIdentityRule(params['id']!);
    json(res, 200, { 'identity-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/identity-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteIdentityRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
