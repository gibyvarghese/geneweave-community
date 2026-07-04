/**
 * @weaveintel/geneweave — Admin catalog CRUD routes
 *
 * Operator management for the per-surface catalog primitives that back
 * `GET /api/me/catalog`:
 *   - mode_labels     → /api/admin/mode-labels
 *   - starter_prompts → /api/admin/starter-prompts
 *
 * RBAC: registered on the admin router, so every route is gated by
 * `admin:tenant:write` (tenant_admin / platform_admin) before the handler
 * runs. Handlers keep a defensive `if (!auth)` guard.
 *
 * Cache note: the Gap-2 surface-catalog resolver caches per
 * (tenant, principal, surface) for `cacheTtlMs` (default from
 * `@weaveintel/identity`). Mutations here are visible to `/api/me/catalog`
 * within that TTL window; there is no cross-module cache invalidation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike } from '../api/types.js';

const SURFACE_ALLOWLIST = new Set(['web', 'desktop', 'mobile']);
const MAX_LABEL = 80;
const MAX_MODE_KEY = 40;
const MAX_PROMPT_TEXT = 500;

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asTrimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerAdminCatalogRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
): void {
  // ── mode labels ────────────────────────────────────────────────────────

  router.get('/api/admin/mode-labels', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const surfaceId = url.searchParams.get('surfaceId') ?? undefined;
    if (surfaceId !== undefined && !SURFACE_ALLOWLIST.has(surfaceId)) {
      json(res, 400, { error: 'Invalid surfaceId' });
      return;
    }
    const rows = await db.adminListModeLabels(surfaceId);
    json(res, 200, { 'mode-labels': rows });
  });

  router.post('/api/admin/mode-labels', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const body = parseBody(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    const surfaceId = asTrimmed(body['surface_id'] ?? body['surfaceId']);
    const modeKey = asTrimmed(body['mode_key'] ?? body['modeKey']);
    const label = asTrimmed(body['label']);
    if (!SURFACE_ALLOWLIST.has(surfaceId)) { json(res, 400, { error: 'Invalid surface_id' }); return; }
    if (!modeKey || modeKey.length > MAX_MODE_KEY) { json(res, 400, { error: 'mode_key required (max 40 chars)' }); return; }
    if (!label || label.length > MAX_LABEL) { json(res, 400, { error: 'label required (max 80 chars)' }); return; }

    const id = newUUIDv7();
    try {
      await db.createModeLabel({
        id,
        surface_id: surfaceId,
        mode_key: modeKey,
        label,
        description: typeof body['description'] === 'string' ? (body['description'] as string) : null,
        icon: typeof body['icon'] === 'string' ? (body['icon'] as string) : null,
        is_default: body['is_default'] === true || body['is_default'] === 1 ? 1 : 0,
        sort_order: typeof body['sort_order'] === 'number' ? (body['sort_order'] as number) : 0,
        enabled: body['enabled'] === false || body['enabled'] === 0 ? 0 : 1,
        metadata: typeof body['metadata'] === 'string' ? (body['metadata'] as string) : null,
      });
    } catch {
      json(res, 409, { error: 'mode_key already exists for this surface' });
      return;
    }
    const created = await db.getModeLabel(id);
    json(res, 201, { 'mode-label': created });
  });

  router.put('/api/admin/mode-labels/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getModeLabel(id);
    if (!existing) { json(res, 404, { error: 'Not found' }); return; }
    const body = parseBody(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    const patch: Parameters<DatabaseAdapter['updateModeLabel']>[1] = {};
    if (body['label'] !== undefined) {
      const label = asTrimmed(body['label']);
      if (!label || label.length > MAX_LABEL) { json(res, 400, { error: 'label must be 1-80 chars' }); return; }
      patch.label = label;
    }
    if (body['mode_key'] !== undefined) {
      const modeKey = asTrimmed(body['mode_key']);
      if (!modeKey || modeKey.length > MAX_MODE_KEY) { json(res, 400, { error: 'mode_key must be 1-40 chars' }); return; }
      patch.mode_key = modeKey;
    }
    if (body['description'] !== undefined) patch.description = typeof body['description'] === 'string' ? (body['description'] as string) : null;
    if (body['icon'] !== undefined) patch.icon = typeof body['icon'] === 'string' ? (body['icon'] as string) : null;
    if (body['is_default'] !== undefined) patch.is_default = body['is_default'] === true || body['is_default'] === 1 ? 1 : 0;
    if (body['sort_order'] !== undefined && typeof body['sort_order'] === 'number') patch.sort_order = body['sort_order'] as number;
    if (body['enabled'] !== undefined) patch.enabled = body['enabled'] === false || body['enabled'] === 0 ? 0 : 1;
    if (body['metadata'] !== undefined) patch.metadata = typeof body['metadata'] === 'string' ? (body['metadata'] as string) : null;

    await db.updateModeLabel(id, patch);
    json(res, 200, { 'mode-label': await db.getModeLabel(id) });
  });

  router.del('/api/admin/mode-labels/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getModeLabel(id);
    if (!existing) { json(res, 404, { error: 'Not found' }); return; }
    await db.deleteModeLabel(id);
    json(res, 200, { deleted: true, id });
  });

  // ── starter prompts ────────────────────────────────────────────────────

  router.get('/api/admin/starter-prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const surfaceId = url.searchParams.get('surfaceId') ?? undefined;
    if (surfaceId !== undefined && !SURFACE_ALLOWLIST.has(surfaceId)) {
      json(res, 400, { error: 'Invalid surfaceId' });
      return;
    }
    const rows = await db.adminListStarterPrompts(surfaceId);
    json(res, 200, { 'starter-prompts': rows });
  });

  router.post('/api/admin/starter-prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const body = parseBody(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    const surfaceId = asTrimmed(body['surface_id'] ?? body['surfaceId']);
    const label = asTrimmed(body['label']);
    const promptText = asTrimmed(body['prompt_text'] ?? body['promptText']);
    if (!SURFACE_ALLOWLIST.has(surfaceId)) { json(res, 400, { error: 'Invalid surface_id' }); return; }
    if (!label || label.length > MAX_LABEL) { json(res, 400, { error: 'label required (max 80 chars)' }); return; }
    if (!promptText || promptText.length > MAX_PROMPT_TEXT) { json(res, 400, { error: 'prompt_text required (max 500 chars)' }); return; }

    const id = newUUIDv7();
    await db.createStarterPrompt({
      id,
      surface_id: surfaceId,
      label,
      prompt_text: promptText,
      sort_order: typeof body['sort_order'] === 'number' ? (body['sort_order'] as number) : 0,
      enabled: body['enabled'] === false || body['enabled'] === 0 ? 0 : 1,
      metadata: typeof body['metadata'] === 'string' ? (body['metadata'] as string) : null,
    });
    json(res, 201, { 'starter-prompt': await db.getStarterPrompt(id) });
  });

  router.put('/api/admin/starter-prompts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getStarterPrompt(id);
    if (!existing) { json(res, 404, { error: 'Not found' }); return; }
    const body = parseBody(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    const patch: Parameters<DatabaseAdapter['updateStarterPrompt']>[1] = {};
    if (body['label'] !== undefined) {
      const label = asTrimmed(body['label']);
      if (!label || label.length > MAX_LABEL) { json(res, 400, { error: 'label must be 1-80 chars' }); return; }
      patch.label = label;
    }
    if (body['prompt_text'] !== undefined) {
      const promptText = asTrimmed(body['prompt_text']);
      if (!promptText || promptText.length > MAX_PROMPT_TEXT) { json(res, 400, { error: 'prompt_text must be 1-500 chars' }); return; }
      patch.prompt_text = promptText;
    }
    if (body['sort_order'] !== undefined && typeof body['sort_order'] === 'number') patch.sort_order = body['sort_order'] as number;
    if (body['enabled'] !== undefined) patch.enabled = body['enabled'] === false || body['enabled'] === 0 ? 0 : 1;
    if (body['metadata'] !== undefined) patch.metadata = typeof body['metadata'] === 'string' ? (body['metadata'] as string) : null;

    await db.updateStarterPrompt(id, patch);
    json(res, 200, { 'starter-prompt': await db.getStarterPrompt(id) });
  });

  router.del('/api/admin/starter-prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getStarterPrompt(id);
    if (!existing) { json(res, 404, { error: 'Not found' }); return; }
    await db.deleteStarterPrompt(id);
    json(res, 200, { deleted: true, id });
  });
}
