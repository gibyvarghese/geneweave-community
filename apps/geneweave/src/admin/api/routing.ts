import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RoutingPolicyRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { guardCustomizable, guardKeyCollision } from './realm-guards.js';
import { buildTenantRoutingPolicyFork } from '../../routing-policy-realm.js';

/**
 * Register routing policy admin routes
 *
 * Routes:
 * - GET /api/admin/routing
 * - GET /api/admin/routing/:id
 * - POST /api/admin/routing
 * - PUT /api/admin/routing/:id
 * - DEL /api/admin/routing/:id
 */
export function registerRoutingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers
): void {
  const { json, readBody } = helpers;

  // List all policies, OR — with ?tenantId= — the EFFECTIVE routing-policy set for that tenant (its own
  // forks + a parent org's shared forks + the globals, nearest-owner-wins).
  router.get('/api/admin/routing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const policies = tenantId ? await db.resolveTenantEffectiveRoutingPolicies(tenantId) : await db.listRoutingPolicies();
    json(res, 200, { policies, ...(tenantId ? { tenantId } : {}) });
  }, { auth: true });

  router.get('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getRoutingPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Routing policy not found' }); return; }
    json(res, 200, { policy: p });
  }, { auth: true });

  // ── Admin: Tenancy Realm — per-tenant routing-policy customization (content fork) ────────────────
  const ROUTING_OVERRIDE_KEYS = ['description', 'strategy', 'constraints', 'weights', 'fallback_model', 'fallback_provider', 'fallback_chain', 'share_mode'] as const;
  const JSON_ROUTING_KEYS = new Set(['constraints', 'weights', 'fallback_chain']);

  // Who-gets-what for a tenant: the effective policy + where it came from.
  router.get('/api/admin/routing/:id/realm', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const base = await db.getRoutingPolicy(params['id']!);
    if (!base) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const logicalKey = base.logical_key ?? base.name;
    const effective = tenantId
      ? (await db.resolveTenantEffectiveRoutingPolicies(tenantId)).find((p) => (p.logical_key ?? p.name) === logicalKey) ?? base
      : base;
    const kind = effective.realm === 'tenant' ? (effective.owner_tenant_id === tenantId ? 'own_override' : 'inherited') : 'global';
    json(res, 200, { effective, provenance: { kind }, tenantId });
  }, { auth: true });

  // Create/replace a tenant's fork of this global routing policy.
  router.post('/api/admin/routing/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getRoutingPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Routing policy not found' }); return; }
    if (global.realm === 'tenant') { json(res, 400, { error: 'Can only customize a global policy, not an existing tenant copy' }); return; }
    // D15: a deprecated global default may not gain new forks (existing forks keep working).
    if (!guardCustomizable(json, res, global)) return;
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = body['tenantId'];
    if (typeof tenantId !== 'string' || !tenantId.trim()) { json(res, 400, { error: 'tenantId required' }); return; }
    const overrides: Record<string, unknown> = {};
    for (const k of ROUTING_OVERRIDE_KEYS) {
      if (body[k] === undefined) continue;
      overrides[k] = (JSON_ROUTING_KEYS.has(k) && body[k] !== null && typeof body[k] === 'object') ? JSON.stringify(body[k]) : body[k];
    }
    const logicalKey = global.logical_key ?? global.name;
    const existing = (await db.listRoutingPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.name) === logicalKey);
    if (existing) await db.deleteRoutingPolicy(existing.id);
    const fork = buildTenantRoutingPolicyFork(global, tenantId, overrides as Parameters<typeof buildTenantRoutingPolicyFork>[2]);
    await db.insertRealmRoutingPolicyRow(fork);
    const saved = await db.getRoutingPolicy(fork.id);
    json(res, 201, { fork: saved, replacedExisting: Boolean(existing) });
  }, { auth: true, csrf: true });

  // Revert: drop a tenant's routing-policy fork so it falls back to the global built-in.
  router.del('/api/admin/routing/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getRoutingPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const logicalKey = global.logical_key ?? global.name;
    const fork = (await db.listRoutingPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.name) === logicalKey);
    if (!fork) { json(res, 404, { error: 'No customization for this tenant' }); return; }
    await db.deleteRoutingPolicy(fork.id);
    json(res, 200, { ok: true, reverted: fork.id });
  }, { auth: true, csrf: true });

  router.post('/api/admin/routing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['strategy']) { json(res, 400, { error: 'name and strategy required' }); return; }
    // D17: if the caller can already SEE this logical key, they must Customize it, not create a twin.
    if (!await guardKeyCollision(json, res, db, 'routing_policies', String(body['name']), auth)) return;
    const id = 'route-' + newUUIDv7().slice(-8);
    await db.createRoutingPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      strategy: body['strategy'] as string,
      constraints: body['constraints'] ? JSON.stringify(body['constraints']) : null,
      weights: body['weights'] ? JSON.stringify(body['weights']) : null,
      fallback_model: (body['fallback_model'] as string) ?? null,
      fallback_provider: (body['fallback_provider'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const policy = await db.getRoutingPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/routing/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRoutingPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['constraints'] !== undefined) fields['constraints'] = JSON.stringify(body['constraints']);
    if (body['weights'] !== undefined) fields['weights'] = JSON.stringify(body['weights']);
    if (body['fallback_model'] !== undefined) fields['fallback_model'] = body['fallback_model'];
    if (body['fallback_provider'] !== undefined) fields['fallback_provider'] = body['fallback_provider'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRoutingPolicy(params['id']!, fields as Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>);
    const policy = await db.getRoutingPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRoutingPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
