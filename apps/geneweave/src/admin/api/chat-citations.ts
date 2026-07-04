// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant answer-citations config (m138). Mirrors the tenant-appearance / ai-transparency
 * CRUD contract so it drops straight into the Builder ({ tenants: [...] } list + per-tenant GET/PUT).
 *
 * An admin controls whether "Cite sources" is offered in chat, how many distinct sources an answer must cite
 * to count as grounded (the strictness dial → enforceCitationStrictness), which corpus to search (notes /
 * past chats / all), and how many sources to retrieve.
 *
 *   GET /api/admin/chat-citations               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/chat-citations/:tenantId     — one tenant's config
 *   PUT /api/admin/chat-citations/:tenantId     — update the config
 */
import { createChatCitationsService } from '../../chat-citations-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantChatCitationsRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/chat-citations';

function toRow(t: TenantChatCitationsRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, enabled: t.enabled, min_citations: t.min_citations, scope: t.scope, max_sources: t.max_sources };
}

export function registerChatCitationsRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createChatCitationsService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantChatCitations();
    const tenants = rows.map(toRow);
    const own = auth.tenantId ?? 'default';
    if (!tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toRow(await svc.getConfig(own)));
    json(res, 200, { tenants, scopes: ['all', 'notes', 'runs'] });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    json(res, 200, { tenants: toRow(await svc.getConfig(tenantId)), scopes: ['all', 'notes', 'runs'] });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Parameters<typeof svc.updateConfig>[1] = {};
    if (body['enabled'] !== undefined) patch.enabled = body['enabled'] ? 1 : 0;
    if (body['min_citations'] !== undefined) patch.min_citations = Number(body['min_citations']);
    if (body['max_sources'] !== undefined) patch.max_sources = Number(body['max_sources']);
    if (typeof body['scope'] === 'string') patch.scope = body['scope'];
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
