import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import { hashPassword } from '../../auth.js';
import type { RouterLike } from '../api/types.js';

export function registerAdminUserRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
): void {
  const sanitizeUser = (user: Awaited<ReturnType<DatabaseAdapter['getUserById']>>) => {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      persona: user.persona,
      tenant_id: user.tenant_id,
      created_at: user.created_at,
    };
  };

  router.get('/api/admin/users', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const isPlatformAdmin = auth.persona === 'platform_admin';
    const filter = isPlatformAdmin ? undefined : { tenantId: auth.tenantId ?? null };
    const users = await db.listUsers(filter);
    json(res, 200, {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        persona: u.persona,
        tenant_id: u.tenant_id,
        created_at: u.created_at,
      })),
    });
  });

  router.get('/api/admin/users/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const user = await db.getUserById(params['id']!);
    if (!user) { json(res, 404, { error: 'User not found' }); return; }
    json(res, 200, { user: sanitizeUser(user) });
  });

  router.post('/api/admin/users', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const email = String(body['email'] ?? '').trim().toLowerCase();
    const name = String(body['name'] ?? '').trim();
    const password = String(body['password'] ?? '');
    const persona = String(body['persona'] ?? 'tenant_user').trim() || 'tenant_user';
    const tenantId = body['tenant_id'] === undefined || body['tenant_id'] === null || body['tenant_id'] === ''
      ? null
      : String(body['tenant_id']);

    if (!email || !name || !password) {
      json(res, 400, { error: 'email, name, and password are required' });
      return;
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      json(res, 409, { error: 'A user with this email already exists' });
      return;
    }

    const id = newUUIDv7();
    const passwordHash = await hashPassword(password);
    await db.createUser({
      id,
      email,
      name,
      passwordHash,
      persona,
      tenantId,
    });
    const user = await db.getUserById(id);
    json(res, 201, { user: sanitizeUser(user) });
  }, { auth: true, csrf: true });

  router.put('/api/admin/users/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getUserById(params['id']!);
    if (!existing) { json(res, 404, { error: 'User not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const updates: {
      email?: string;
      name?: string;
      persona?: string;
      tenantId?: string | null;
      passwordHash?: string;
    } = {};

    if (body['email'] !== undefined) {
      const email = String(body['email'] ?? '').trim().toLowerCase();
      if (!email) { json(res, 400, { error: 'email cannot be empty' }); return; }
      const emailOwner = await db.getUserByEmail(email);
      if (emailOwner && emailOwner.id !== existing.id) {
        json(res, 409, { error: 'A user with this email already exists' });
        return;
      }
      updates.email = email;
    }
    if (body['name'] !== undefined) {
      const name = String(body['name'] ?? '').trim();
      if (!name) { json(res, 400, { error: 'name cannot be empty' }); return; }
      updates.name = name;
    }
    if (body['persona'] !== undefined) {
      updates.persona = String(body['persona'] ?? '').trim() || 'tenant_user';
    }
    if (body['tenant_id'] !== undefined) {
      updates.tenantId = body['tenant_id'] === null || body['tenant_id'] === ''
        ? null
        : String(body['tenant_id']);
    }
    if (body['password'] !== undefined) {
      const password = String(body['password'] ?? '').trim();
      if (password) {
        updates.passwordHash = await hashPassword(password);
      }
    }

    await db.updateUser(existing.id, updates);
    const user = await db.getUserById(existing.id);
    json(res, 200, { user: sanitizeUser(user) });
  }, { auth: true, csrf: true });

  router.del('/api/admin/users/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const user = await db.getUserById(params['id']!);
    if (!user) { json(res, 404, { error: 'User not found' }); return; }
    if (user.id === auth.userId) {
      json(res, 400, { error: 'Cannot delete currently authenticated user' });
      return;
    }
    await db.deleteUser(user.id);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
