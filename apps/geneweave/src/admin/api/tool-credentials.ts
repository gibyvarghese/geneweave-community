/**
 * @weaveintel/geneweave — Admin Tool Credentials routes (Phase 4)
 *
 * CRUD endpoints for operator-managed credential bindings. Secrets live in
 * environment variables referenced by env_var_name; no plaintext secrets are
 * stored in the database. The validate action checks whether the referenced
 * env var is present and updates validation_status accordingly.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { ToolCredentialRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolCredentialRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ── List ───────────────────────────────────────────────────

  router.get('/api/admin/tool-credentials', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const credentials = await db.listToolCredentials();
    json(res, 200, { credentials });
  }, { auth: true });

  // ── Get by ID ──────────────────────────────────────────────

  router.get('/api/admin/tool-credentials/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const credential = await db.getToolCredential(params['id']!);
    if (!credential) { json(res, 404, { error: 'Tool credential not found' }); return; }
    json(res, 200, { credential });
  }, { auth: true });

  // ── Create ─────────────────────────────────────────────────

  router.post('/api/admin/tool-credentials', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['credential_type']) {
      json(res, 400, { error: 'name and credential_type required' }); return;
    }
    const id = newUUIDv7();
    await db.createToolCredential({
      id,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      credential_type: body['credential_type'] as string,
      tool_names: body['tool_names']
        ? (typeof body['tool_names'] === 'string' ? body['tool_names'] : JSON.stringify(body['tool_names']))
        : null,
      env_var_name: (body['env_var_name'] as string) ?? null,
      config: body['config']
        ? (typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']))
        : null,
      rotation_due_at: (body['rotation_due_at'] as string) ?? null,
      validation_status: 'unknown',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const credential = await db.getToolCredential(id);
    json(res, 201, { credential });
  }, { auth: true, csrf: true });

  // ── Update ─────────────────────────────────────────────────

  router.put('/api/admin/tool-credentials/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolCredential(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool credential not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['credential_type'] !== undefined) fields['credential_type'] = body['credential_type'];
    if (body['tool_names'] !== undefined) {
      fields['tool_names'] = typeof body['tool_names'] === 'string'
        ? body['tool_names']
        : JSON.stringify(body['tool_names']);
    }
    if (body['env_var_name'] !== undefined) fields['env_var_name'] = body['env_var_name'];
    if (body['config'] !== undefined) {
      fields['config'] = typeof body['config'] === 'string'
        ? body['config']
        : JSON.stringify(body['config']);
    }
    if (body['rotation_due_at'] !== undefined) fields['rotation_due_at'] = body['rotation_due_at'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    // Reset validation_status to 'unknown' whenever env_var_name changes
    if (body['env_var_name'] !== undefined) fields['validation_status'] = 'unknown';
    await db.updateToolCredential(params['id']!, fields as Partial<Omit<ToolCredentialRow, 'id' | 'created_at' | 'updated_at'>>);
    const credential = await db.getToolCredential(params['id']!);
    json(res, 200, { credential });
  }, { auth: true, csrf: true });

  // ── Delete ─────────────────────────────────────────────────

  router.del('/api/admin/tool-credentials/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolCredential(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Validate action ────────────────────────────────────────
  // Resolves the env var referenced by the credential and updates
  // validation_status in the DB. Returns { status, configured } where
  // `configured` indicates the env var is set (does not expose the value).

  router.post('/api/admin/tool-credentials/:id/validate', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolCredential(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool credential not found' }); return; }
    const result = await db.validateToolCredential(params['id']!);
    json(res, 200, { status: result.status, configured: result.value !== null });
  }, { auth: true, csrf: true });
}
