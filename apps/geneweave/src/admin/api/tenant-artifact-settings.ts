/**
 * Admin routes for tenant artifact settings (m78 Phase 2).
 *
 * Operators configure per-tenant artifact type allowlists, size limits,
 * and rendering policies (preview_enabled, sandbox_html).
 *
 * Routes:
 *   GET  /api/admin/tenant-artifact-settings           — list all tenant configs
 *   GET  /api/admin/tenant-artifact-settings/:tenantId — get single tenant config
 *   PUT  /api/admin/tenant-artifact-settings/:tenantId — upsert tenant config
 *   DELETE /api/admin/tenant-artifact-settings/:tenantId — delete (reverts to default)
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import type { TenantArtifactSettingsRow } from '../../db-types/artifacts.js';

const ALL_ARTIFACT_TYPES = [
  'text', 'markdown', 'csv', 'json', 'code',
  'html', 'pdf', 'report',
  'image', 'svg', 'diagram',
  'mermaid',
  'react', 'interactive',
  'audio', 'video',
  'spreadsheet',
  'custom',
] as const;

function rowToPublic(row: TenantArtifactSettingsRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    allowed_types: row.allowed_types ? (() => { try { return JSON.parse(row.allowed_types!); } catch { return null; } })() : null,
    max_size_bytes: row.max_size_bytes,
    require_policy: Boolean(row.require_policy),
    preview_enabled: Boolean(row.preview_enabled),
    sandbox_html: Boolean(row.sandbox_html),
    emit_enabled: Boolean(row.emit_enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const BASE = '/api/admin/tenant-artifact-settings';

export function registerTenantArtifactSettingsRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;
  const dbEx = db as unknown as {
    listTenantArtifactSettings?: () => Promise<TenantArtifactSettingsRow[]>;
    getTenantArtifactSettings?: (tenantId: string) => Promise<TenantArtifactSettingsRow | null>;
    getEffectiveTenantArtifactSettings?: (tenantId: string) => Promise<TenantArtifactSettingsRow | null>;
    upsertTenantArtifactSettings?: (tenantId: string, fields: Record<string, unknown>) => Promise<TenantArtifactSettingsRow>;
    deleteTenantArtifactSettings?: (tenantId: string) => Promise<void>;
  };

  // ── List all tenant configs ──────────────────────────────────────────────────
  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!dbEx.listTenantArtifactSettings) { json(res, 501, { error: 'Not available' }); return; }
    const rows = await dbEx.listTenantArtifactSettings();
    json(res, 200, {
      settings: rows.map(rowToPublic),
      all_types: ALL_ARTIFACT_TYPES,
    });
  });

  // ── Get single tenant config (or effective / merged with default) ────────────
  router.get(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!dbEx.getTenantArtifactSettings || !dbEx.getEffectiveTenantArtifactSettings) {
      json(res, 501, { error: 'Not available' }); return;
    }
    const tenantId = params['tenantId'] ?? '';
    const url = new URL(req.url ?? '', 'http://x');
    const effective = url.searchParams.get('effective') === 'true';
    const row = effective
      ? await dbEx.getEffectiveTenantArtifactSettings(tenantId)
      : await dbEx.getTenantArtifactSettings(tenantId);
    if (!row) { json(res, 404, { error: 'Settings not found for this tenant' }); return; }
    json(res, 200, { settings: rowToPublic(row), all_types: ALL_ARTIFACT_TYPES });
  });

  // ── Upsert tenant config ─────────────────────────────────────────────────────
  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!dbEx.upsertTenantArtifactSettings) { json(res, 501, { error: 'Not available' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }

    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    // Validate allowed_types if provided
    if (body['allowed_types'] !== undefined && body['allowed_types'] !== null) {
      const types = Array.isArray(body['allowed_types']) ? body['allowed_types'] : JSON.parse(body['allowed_types'] as string);
      const invalid = types.filter((t: string) => !(ALL_ARTIFACT_TYPES as readonly string[]).includes(t));
      if (invalid.length > 0) {
        json(res, 400, { error: `Unknown artifact type(s): ${invalid.join(', ')}` }); return;
      }
      body['allowed_types'] = JSON.stringify(types);
    }

    const fields: Record<string, unknown> = {};
    if (body['allowed_types'] !== undefined) fields['allowed_types'] = body['allowed_types'];
    if (body['max_size_bytes'] !== undefined) fields['max_size_bytes'] = Number(body['max_size_bytes']) || null;
    if (body['require_policy'] !== undefined) fields['require_policy'] = Boolean(body['require_policy']);
    if (body['preview_enabled'] !== undefined) fields['preview_enabled'] = Boolean(body['preview_enabled']);
    if (body['sandbox_html'] !== undefined) fields['sandbox_html'] = Boolean(body['sandbox_html']);
    if (body['emit_enabled'] !== undefined) fields['emit_enabled'] = Boolean(body['emit_enabled']);

    const row = await dbEx.upsertTenantArtifactSettings(tenantId, fields);
    json(res, 200, { settings: rowToPublic(row) });
  });

  // ── Delete tenant config (reverts to global default) ────────────────────────
  router.del(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!dbEx.deleteTenantArtifactSettings) { json(res, 501, { error: 'Not available' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (tenantId === 'default') { json(res, 400, { error: 'Cannot delete the global default settings' }); return; }
    await dbEx.deleteTenantArtifactSettings(tenantId);
    json(res, 200, { ok: true });
  });
}
