import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { ComplianceRuleRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register compliance rule admin routes
 */
export function registerComplianceRuleRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/compliance-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listComplianceRules();
    json(res, 200, { 'compliance-rules': items });
  }, { auth: true });

  router.get('/api/admin/compliance-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getComplianceRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Compliance rule not found' }); return; }
    json(res, 200, { 'compliance-rule': c });
  }, { auth: true });

  router.post('/api/admin/compliance-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'comp-' + newUUIDv7().slice(-8);
    await db.createComplianceRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      rule_type: (body['rule_type'] as string) ?? 'retention',
      target_resource: (body['target_resource'] as string) ?? '*',
      retention_days: (body['retention_days'] as number) ?? null,
      region: (body['region'] as string) ?? null,
      consent_purpose: (body['consent_purpose'] as string) ?? null,
      action: (body['action'] as string) ?? 'notify',
      config: body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getComplianceRule(id);
    json(res, 201, { 'compliance-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/compliance-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getComplianceRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Compliance rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['target_resource'] !== undefined) fields['target_resource'] = body['target_resource'];
    if (body['retention_days'] !== undefined) fields['retention_days'] = body['retention_days'];
    if (body['region'] !== undefined) fields['region'] = body['region'];
    if (body['consent_purpose'] !== undefined) fields['consent_purpose'] = body['consent_purpose'];
    if (body['action'] !== undefined) fields['action'] = body['action'];
    if (body['config'] !== undefined) fields['config'] = body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateComplianceRule(params['id']!, fields as Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>);
    const item = await db.getComplianceRule(params['id']!);
    json(res, 200, { 'compliance-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/compliance-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteComplianceRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
