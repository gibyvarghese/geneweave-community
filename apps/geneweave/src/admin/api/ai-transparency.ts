// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant AI transparency (m137). Mirrors the tenant-appearance CRUD contract so it drops
 * straight into the Builder ({ tenants: [...] } list + per-tenant GET/PUT). Grounded in the EU AI Act
 * Article 50 duty to tell people when they are interacting with AI: an admin controls whether assistant
 * answers carry an "AI-generated" label, the disclosure wording, whether sensitive-topic content warnings
 * show, and whether answer feedback is collected.
 *
 *   GET /api/admin/ai-transparency               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/ai-transparency/:tenantId     — one tenant's config + a plain-language feedback summary
 *   PUT /api/admin/ai-transparency/:tenantId     — update the config
 *   GET /api/admin/answer-feedback/summary        — aggregate answer feedback (the review_answer_feedback shape)
 */
import { createAnswerFeedbackService } from '../../answer-feedback-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantAiTransparencyRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/ai-transparency';

function toRow(t: TenantAiTransparencyRow): Record<string, unknown> {
  return {
    tenant_id: t.tenant_id,
    show_ai_label: t.show_ai_label,
    disclosure_text: t.disclosure_text,
    content_warnings: t.content_warnings,
    feedback_enabled: t.feedback_enabled,
  };
}

export function registerAiTransparencyRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createAnswerFeedbackService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantAiTransparency();
    const tenants = rows.map(toRow);
    const own = auth.tenantId ?? 'default';
    if (!tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toRow(await svc.getTransparency(own)));
    json(res, 200, { tenants });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    const t = await svc.getTransparency(tenantId);
    const summary = await svc.summarize(auth.tenantId ?? null, 1000);
    json(res, 200, { tenants: toRow(t), summary });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Parameters<typeof svc.updateTransparency>[1] = {};
    if (body['show_ai_label'] !== undefined) patch.show_ai_label = body['show_ai_label'] ? 1 : 0;
    if (body['content_warnings'] !== undefined) patch.content_warnings = body['content_warnings'] ? 1 : 0;
    if (body['feedback_enabled'] !== undefined) patch.feedback_enabled = body['feedback_enabled'] ? 1 : 0;
    if (typeof body['disclosure_text'] === 'string') patch.disclosure_text = body['disclosure_text'];
    const next = await svc.updateTransparency(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });

  router.get('/api/admin/answer-feedback/summary', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { summary: await svc.summarize(auth.tenantId ?? null, 2000) });
  });
}
