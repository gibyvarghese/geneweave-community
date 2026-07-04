/**
 * /api/me/account — the Account settings surface (design: "GeneWeave Account.dc.html").
 *
 * Everything here is per-USER and self-serve: a caller only ever reads or changes their OWN account
 * (the user id comes from the authenticated session, never the request body).
 *
 *   GET  /api/me/account                 the effective account (profile + preferences + notifications)
 *   PUT  /api/me/account/profile         patch profile + formatting preferences (validated/sanitised in the service)
 *   PUT  /api/me/account/notifications   set one event's channels: { event, in_app?, email?, push? }
 *   GET  /api/me/account/people          workspace members the user can see (People section; tenant-scoped)
 *   GET  /api/me/account/sessions        the caller's own device/session list (Security section)
 *
 * The People / Admin / Billing sections of the design that are workspace-wide are reached from here for
 * read-only display and deep-link into the Builder for the admin-only controls.
 */
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createAccountService } from '../account-sql.js';

export function registerMeAccountRoutes(router: Router, db: DatabaseAdapter): void {
  const account = createAccountService(db);

  router.get('/api/me/account', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const view = await account.getAccount(auth.userId);
    if (!view) { json(res, 404, { error: 'Account not found' }); return; }
    json(res, 200, { account: view });
  });

  router.put('/api/me/account/profile', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const r = await account.updateProfile(auth.userId, body);
    const view = await account.getAccount(auth.userId);
    json(res, 200, { ok: r.ok, applied: r.applied, account: view });
  }, { auth: true, csrf: true });

  router.put('/api/me/account/notifications', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const event = typeof body['event'] === 'string' ? body['event'] : '';
    const channels: { in_app?: boolean; email?: boolean; push?: boolean } = {};
    if ('in_app' in body) channels.in_app = !!body['in_app'];
    if ('email' in body) channels.email = !!body['email'];
    if ('push' in body) channels.push = !!body['push'];
    const r = await account.setNotification(auth.userId, event, channels);
    if (!r.ok) { json(res, 400, { error: r.error }); return; }
    const view = await account.getAccount(auth.userId);
    json(res, 200, { ok: true, account: view });
  }, { auth: true, csrf: true });

  // People — the workspace members the caller can see (tenant-scoped for non-platform-admins). Read-only
  // here; invites + role changes live in the Builder (Users) so RBAC is enforced in one place.
  router.get('/api/me/account/people', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const isPlatformAdmin = auth.persona === 'platform_admin';
    const filter = isPlatformAdmin ? undefined : { tenantId: auth.tenantId ?? null };
    const users = await db.listUsers(filter);
    json(res, 200, {
      people: users.map((u) => ({
        id: u.id, name: u.name, email: u.email, persona: u.persona,
        is_you: u.id === auth.userId,
      })),
      canManage: ['tenant_admin', 'platform_admin'].includes(auth.persona),
    });
  });

  // Sessions — the Security section's device list. We surface the caller's current device; a full session
  // registry is out of scope, so we're honest about what we can show rather than inventing rows.
  router.get('/api/me/account/sessions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const ua = String(req.headers['user-agent'] ?? '');
    const label = ua.includes('Mobile') ? 'Mobile browser' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Browser';
    json(res, 200, { sessions: [{ device: `This device · ${label}`, current: true }] });
  });
}
