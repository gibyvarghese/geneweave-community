// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant internationalisation policy (m145). Mirrors the tenant-appearance CRUD contract so
 * it drops into the Builder ({ tenants: [...] } list + per-tenant GET/PUT). Controls the workspace's default
 * UI language, which languages members may pick, and whether the assistant replies in the reader's language.
 *
 * Creating a NEW language (an AI locale pack) is a conversational action — the weave_translator agent's
 * translate_ui tool — so it is not duplicated here; this endpoint reports which packs exist.
 *
 *   GET /api/admin/i18n               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/i18n/:tenantId     — one tenant's policy + available locales + existing AI packs
 *   PUT /api/admin/i18n/:tenantId     — update the policy
 */
import { createI18nService } from '../../i18n-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantLocalesRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/i18n';

function toRow(t: TenantLocalesRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, default_locale: t.default_locale, enabled_locales: t.enabled_locales, assistant_localized: t.assistant_localized };
}

export function registerI18nRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createI18nService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantLocales();
    const tenants = rows.map(toRow);
    const own = auth.tenantId ?? 'default';
    if (!tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toRow(await svc.getConfig(own)));
    json(res, 200, { tenants });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    const cfg = await svc.getConfig(tenantId);
    const available = await svc.listAvailableLocales(tenantId);
    const packs = (await db.listTenantUiTranslations(tenantId)).map((p) => ({ locale: p.locale, source: p.source, key_count: p.key_count, updated_at: p.updated_at }));
    json(res, 200, { tenants: toRow(cfg), available, packs });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Parameters<typeof svc.updateConfig>[1] = {};
    if (typeof body['default_locale'] === 'string') patch.default_locale = body['default_locale'];
    if (body['enabled_locales'] !== undefined) patch.enabled_locales = Array.isArray(body['enabled_locales']) ? JSON.stringify(body['enabled_locales']) : String(body['enabled_locales']);
    if (body['assistant_localized'] !== undefined) patch.assistant_localized = body['assistant_localized'] ? 1 : 0;
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
