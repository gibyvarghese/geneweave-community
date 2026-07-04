/**
 * /api/me/suggested-prompts — starter prompts for the signed-in reader's empty chat (m146).
 *
 *   GET  /api/me/suggested-prompts?limit=   the effective starter list (curated + personalised, instant)
 *   POST /api/me/suggested-prompts/click    log which starter was picked { promptId, title?, source? }
 *
 * The list is owner-scoped (built only from the caller's own recent notes + chats) and needs no LLM — the
 * empty chat renders it immediately. The suggest_prompts tool separately refreshes the AI-personalised cache.
 */
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createSuggestedPromptsService } from '../suggested-prompts-sql.js';

export function registerMeSuggestedPromptsRoutes(router: Router, db: DatabaseAdapter): void {
  const svc = createSuggestedPromptsService(db);

  router.get('/api/me/suggested-prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(12, Math.floor(limRaw)) : undefined;
    const r = await svc.getSuggestions({ userId: auth.userId, tenantId: auth.tenantId ?? null, ...(limit ? { limit } : {}) });
    json(res, 200, { enabled: r.enabled, prompts: r.prompts });
  });

  router.post('/api/me/suggested-prompts/click', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const promptId = typeof body['promptId'] === 'string' ? body['promptId'] : '';
    if (!promptId) { json(res, 400, { error: 'promptId is required' }); return; }
    await svc.logClick({
      userId: auth.userId, tenantId: auth.tenantId ?? null, promptId,
      ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      ...(typeof body['source'] === 'string' ? { source: body['source'] } : {}),
    });
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
