import type { ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { getAvailableTools } from '../tools.js';
import { normalizePersona } from '../rbac.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';

export function registerModelRoutes(
  router: Router,
  _db: DatabaseAdapter,
  chatEngine: ChatEngine,
  _providers?: Record<string, { apiKey?: string }>,
): void {

  // ── Model routes ───────────────────────────────────────────

  router.get('/api/models', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const models = await chatEngine.getAvailableModels();
    json(res, 200, {
      models,
      defaultModel: (chatEngine as any).config.defaultProvider + ':' + (chatEngine as any).config.defaultModel,
    });
  });

  // ── Tools routes ───────────────────────────────────────────

  router.get('/api/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { tools: getAvailableTools(auth.persona), persona: normalizePersona(auth.persona) });
  });
}
