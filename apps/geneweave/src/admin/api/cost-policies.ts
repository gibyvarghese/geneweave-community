/**
 * @weaveintel/geneweave — Admin Cost Policies routes
 *
 * Cost Governor Phase 2. CRUD over `cost_policies`. Operators define a tier
 * (economy | balanced | performance | max | custom) plus optional lever
 * overrides serialized as `levers_json` (a partial CostPolicy). Bound to
 * agents / meshes / workflows via `capability_policy_bindings`
 * (policy_kind = 'cost_policy').
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike } from './types.js';
import { buildTenantCostPolicyFork } from '../../cost-policy-realm.js';

export interface CostPolicyRouteHelpers {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
}

const VALID_TIERS = new Set(['economy', 'balanced', 'performance', 'max', 'custom']);

export function registerCostPolicyRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: CostPolicyRouteHelpers,
): void {
  const { json, readBody } = helpers;
  const delMethod = router.del.bind(router);

  // List all policies, OR — with ?tenantId= — the EFFECTIVE cost-policy set for that tenant (its own
  // forks + a parent org's shared forks + the globals, nearest-owner-wins, canonical keys restored).
  router.get('/api/admin/cost-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const policies = tenantId ? await db.resolveTenantEffectiveCostPolicies(tenantId) : await db.listCostPolicies();
    json(res, 200, { policies, ...(tenantId ? { tenantId } : {}) });
  }, { auth: true });

  router.get('/api/admin/cost-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policy = await db.getCostPolicy(params['id']!);
    if (!policy) { json(res, 404, { error: 'Cost policy not found' }); return; }
    json(res, 200, { policy });
  }, { auth: true });

  // ── Admin: Tenancy Realm — per-tenant cost-policy customization (content fork) ────────────────
  const COST_OVERRIDE_KEYS = ['tier', 'levers_json', 'description', 'share_mode'] as const;

  // Who-gets-what for a tenant: the effective policy + where it came from.
  router.get('/api/admin/cost-policies/:id/realm', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const base = await db.getCostPolicy(params['id']!);
    if (!base) { json(res, 404, { error: 'Cost policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const logicalKey = base.logical_key ?? base.key;
    const effective = tenantId
      ? (await db.resolveTenantEffectiveCostPolicies(tenantId)).find((p) => (p.logical_key ?? p.key) === logicalKey) ?? base
      : base;
    const kind = effective.realm === 'tenant' ? (effective.owner_tenant_id === tenantId ? 'own_override' : 'inherited') : 'global';
    json(res, 200, { effective, provenance: { kind }, tenantId });
  }, { auth: true });

  // Create/replace a tenant's fork of this global cost policy.
  router.post('/api/admin/cost-policies/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getCostPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Cost policy not found' }); return; }
    if (global.realm === 'tenant') { json(res, 400, { error: 'Can only customize a global policy, not an existing tenant copy' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = body['tenantId'];
    if (typeof tenantId !== 'string' || !tenantId.trim()) { json(res, 400, { error: 'tenantId required' }); return; }
    if (body['tier'] !== undefined && !VALID_TIERS.has(String(body['tier']))) { json(res, 400, { error: `tier must be one of ${[...VALID_TIERS].join(', ')}` }); return; }
    const overrides: Record<string, unknown> = {};
    for (const k of COST_OVERRIDE_KEYS) {
      if (body[k] === undefined) continue;
      // levers_json → stringify an object payload.
      overrides[k] = (k === 'levers_json' && body[k] !== null && typeof body[k] === 'object') ? JSON.stringify(body[k]) : body[k];
    }
    const logicalKey = global.logical_key ?? global.key;
    const existing = (await db.listCostPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.key) === logicalKey);
    if (existing) await db.deleteCostPolicy(existing.id);
    const fork = buildTenantCostPolicyFork(global, tenantId, overrides as Parameters<typeof buildTenantCostPolicyFork>[2]);
    await db.insertRealmCostPolicyRow(fork);
    const saved = await db.getCostPolicy(fork.id);
    json(res, 201, { fork: saved, replacedExisting: Boolean(existing) });
  }, { auth: true, csrf: true });

  // Revert: drop a tenant's cost-policy fork so it falls back to the global built-in.
  delMethod('/api/admin/cost-policies/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getCostPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Cost policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const logicalKey = global.logical_key ?? global.key;
    const fork = (await db.listCostPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.key) === logicalKey);
    if (!fork) { json(res, 404, { error: 'No customization for this tenant' }); return; }
    await db.deleteCostPolicy(fork.id);
    json(res, 200, { ok: true, reverted: fork.id });
  }, { auth: true, csrf: true });

  router.post('/api/admin/cost-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const key = body['key'];
    if (typeof key !== 'string' || !key.trim()) {
      json(res, 400, { error: 'key required' });
      return;
    }
    const tier = (body['tier'] as string) ?? 'balanced';
    if (!VALID_TIERS.has(tier)) {
      json(res, 400, { error: `tier must be one of ${[...VALID_TIERS].join(', ')}` });
      return;
    }
    const existing = await db.getCostPolicyByKey(key);
    if (existing) { json(res, 409, { error: 'Cost policy with this key already exists' }); return; }

    let leversJson: string | null = null;
    if (body['levers_json'] != null) {
      if (typeof body['levers_json'] === 'string') {
        try { JSON.parse(body['levers_json']); } catch {
          json(res, 400, { error: 'levers_json must be valid JSON' }); return;
        }
        leversJson = body['levers_json'];
      } else if (typeof body['levers_json'] === 'object') {
        leversJson = JSON.stringify(body['levers_json']);
      }
    }

    const id = newUUIDv7();
    await db.createCostPolicy({
      id,
      key,
      tier,
      levers_json: leversJson,
      description: typeof body['description'] === 'string' ? (body['description'] as string) : null,
      enabled: body['enabled'] === false ? 0 : 1,
    });
    const policy = await db.getCostPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/cost-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCostPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Cost policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['tier'] !== undefined) {
      if (!VALID_TIERS.has(body['tier'] as string)) {
        json(res, 400, { error: `tier must be one of ${[...VALID_TIERS].join(', ')}` });
        return;
      }
      fields['tier'] = body['tier'];
    }
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['levers_json'] !== undefined) {
      if (body['levers_json'] === null) {
        fields['levers_json'] = null;
      } else if (typeof body['levers_json'] === 'string') {
        try { JSON.parse(body['levers_json']); } catch {
          json(res, 400, { error: 'levers_json must be valid JSON' }); return;
        }
        fields['levers_json'] = body['levers_json'];
      } else if (typeof body['levers_json'] === 'object') {
        fields['levers_json'] = JSON.stringify(body['levers_json']);
      }
    }

    await db.updateCostPolicy(params['id']!, fields as never);
    const policy = await db.getCostPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  delMethod('/api/admin/cost-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCostPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
