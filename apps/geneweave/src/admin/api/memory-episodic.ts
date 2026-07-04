import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerMemoryEpisodicRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/episodic-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '100', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const items = await db.listAllEpisodicMemory({ userId, limit, offset });
    json(res, 200, { 'episodic-memory': items });
  }, { auth: true });

  router.del('/api/admin/episodic-memory/:userId/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEpisodicMemory(params['id']!, params['userId']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.del('/api/admin/episodic-memory/:userId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.clearUserEpisodicMemory(params['userId']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
