/**
 * /api/me — workspace roles: surface parity + member role management (m143).
 *
 *   GET  /api/me/workspace-access            which UI areas THIS user should see (drives nav gating)
 *   POST /api/me/account/people/:id/role     change a member's role (admin-only, same-tenant, guard-railed)
 *
 * Both scoped to the signed-in user; role changes are RBAC-checked in the service.
 */
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createWorkspaceAccessService } from '../workspace-access-sql.js';

export function registerMeWorkspaceRoutes(router: Router, db: DatabaseAdapter): void {
  const svc = createWorkspaceAccessService(db);

  router.get('/api/me/workspace-access', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const eff = await svc.getEffectiveAccess(auth.persona ?? null, auth.tenantId ?? null);
    json(res, 200, eff);
  });

  router.post('/api/me/account/people/:id/role', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: { persona?: unknown };
    try { body = JSON.parse(await readBody(req)) as { persona?: unknown }; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (typeof body.persona !== 'string' || !body.persona) { json(res, 400, { error: 'persona is required' }); return; }
    const r = await svc.changeMemberRole({
      actor: { userId: auth.userId, tenantId: auth.tenantId ?? null, persona: auth.persona ?? 'tenant_user' },
      targetUserId: params['id']!, newPersona: body.persona,
    });
    if (!r.ok) { json(res, 403, { error: r.error }); return; }
    json(res, 200, { ok: true, persona: r.persona, role: r.role });
  }, { auth: true, csrf: true });
}
