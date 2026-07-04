/**
 * Phase K6 — Kaggle discussion bot admin routes.
 *
 * Two operator surfaces:
 *   - kaggle-discussion-settings: per-tenant kill switch (UPSERT by tenant_id)
 *   - kaggle-discussion-posts: append-only audit of every post the bot made
 *
 * The kill switch is checked by the runtime BEFORE invoking
 * `kaggle.discussions.create`. Even if the tool, policy, and skill are all
 * enabled in the catalog, the post is silently blocked when the switch is
 * off for the requester's tenant.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerKaggleDiscussionRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ─── Kill switch (per-tenant settings) ──────────────────────────────
  router.get('/api/admin/kaggle-discussion-settings', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listKaggleDiscussionSettings();
    json(res, 200, { 'kaggle-discussion-settings': rows });
  }, { auth: true });

  router.get('/api/admin/kaggle-discussion-settings/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const row = await db.getKaggleDiscussionSettings(tenantId);
    if (!row) { json(res, 404, { error: 'Settings not found for tenant' }); return; }
    json(res, 200, row);
  }, { auth: true });

  router.put('/api/admin/kaggle-discussion-settings/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const body = await readBody(req).catch(() => ({})) as { discussion_enabled?: boolean | number; notes?: string | null };
    const enabled = body.discussion_enabled === true || body.discussion_enabled === 1 ? 1 : 0;
    const row = await db.upsertKaggleDiscussionSettings({
      tenant_id: tenantId,
      discussion_enabled: enabled,
      notes: body.notes ?? null,
    });
    json(res, 200, row);
  }, { auth: true });

  // POST /api/admin/kaggle-discussion-settings — same as PUT but body carries tenant_id.
  // Lets the generic admin "Create" form work with the AdminTabDef editable: true contract.
  router.post('/api/admin/kaggle-discussion-settings', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const body = await readBody(req).catch(() => ({})) as { tenant_id?: string; discussion_enabled?: boolean | number; notes?: string | null };
    if (!body.tenant_id) { json(res, 400, { error: 'tenant_id required' }); return; }
    const enabled = body.discussion_enabled === true || body.discussion_enabled === 1 ? 1 : 0;
    const row = await db.upsertKaggleDiscussionSettings({
      tenant_id: body.tenant_id,
      discussion_enabled: enabled,
      notes: body.notes ?? null,
    });
    json(res, 201, row);
  }, { auth: true });

  // ─── Posts log (append-only, read-only from admin UI) ───────────────
  router.get('/api/admin/kaggle-discussion-posts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const tenantId = url.searchParams.get('tenant_id') ?? url.searchParams.get('tenantId') ?? undefined;
    const competitionRef = url.searchParams.get('competition_ref') ?? url.searchParams.get('competitionRef') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const rows = await db.listKaggleDiscussionPosts({ tenantId, competitionRef, limit, offset });
    json(res, 200, { 'kaggle-discussion-posts': rows });
  }, { auth: true });

  router.get('/api/admin/kaggle-discussion-posts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getKaggleDiscussionPost(params['id']!);
    if (!row) { json(res, 404, { error: 'Post not found' }); return; }
    json(res, 200, row);
  }, { auth: true });
}
