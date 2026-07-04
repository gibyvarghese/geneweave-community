/**
 * @weaveintel/geneweave — Admin Capability Policy Bindings routes
 *
 * Phase 5 of the DB-Driven Capability Plan. CRUD over `capability_policy_bindings`.
 * Bindings link a binding kind/ref (agent | mesh | workflow) to a policy kind/ref
 * (tool_policy | guardrail | routing | memory | sandbox) with a precedence weight
 * that the runtime resolver uses to pick the strongest applicable policy.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerCapabilityPolicyBindingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;
  const delMethod = router.del.bind(router);

  router.get('/api/admin/capability-policy-bindings', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const bindings = await db.listCapabilityPolicyBindings();
    json(res, 200, { bindings });
  }, { auth: true });

  router.get('/api/admin/capability-policy-bindings/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const binding = await db.getCapabilityPolicyBinding(params['id']!);
    if (!binding) { json(res, 404, { error: 'Capability policy binding not found' }); return; }
    json(res, 200, { binding });
  }, { auth: true });

  router.post('/api/admin/capability-policy-bindings', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['binding_kind']) { json(res, 400, { error: 'binding_kind required' }); return; }
    if (!body['binding_ref']) { json(res, 400, { error: 'binding_ref required' }); return; }
    if (!body['policy_kind']) { json(res, 400, { error: 'policy_kind required' }); return; }
    if (!body['policy_ref']) { json(res, 400, { error: 'policy_ref required' }); return; }

    const id = newUUIDv7();
    await db.createCapabilityPolicyBinding({
      id,
      binding_kind: body['binding_kind'] as string,
      binding_ref: body['binding_ref'] as string,
      policy_kind: body['policy_kind'] as string,
      policy_ref: body['policy_ref'] as string,
      precedence: typeof body['precedence'] === 'number' ? (body['precedence'] as number) : 10,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const binding = await db.getCapabilityPolicyBinding(id);
    json(res, 201, { binding });
  }, { auth: true, csrf: true });

  router.put('/api/admin/capability-policy-bindings/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCapabilityPolicyBinding(params['id']!);
    if (!existing) { json(res, 404, { error: 'Capability policy binding not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['binding_kind'] !== undefined) fields['binding_kind'] = body['binding_kind'];
    if (body['binding_ref'] !== undefined) fields['binding_ref'] = body['binding_ref'];
    if (body['policy_kind'] !== undefined) fields['policy_kind'] = body['policy_kind'];
    if (body['policy_ref'] !== undefined) fields['policy_ref'] = body['policy_ref'];
    if (body['precedence'] !== undefined) fields['precedence'] = body['precedence'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateCapabilityPolicyBinding(params['id']!, fields as never);
    const binding = await db.getCapabilityPolicyBinding(params['id']!);
    json(res, 200, { binding });
  }, { auth: true, csrf: true });

  delMethod('/api/admin/capability-policy-bindings/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCapabilityPolicyBinding(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
