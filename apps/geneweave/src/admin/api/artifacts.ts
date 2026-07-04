/**
 * Admin routes for artifact storage (m77).
 *
 * Artifacts are read-only from the admin panel — they are created by agents
 * at runtime, not by operators. Operators can browse, inspect versions,
 * download raw data, and delete artifacts.
 */
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { deserializeArtifactData } from '../../lib/artifact-helpers.js';
import type { ArtifactRow, ArtifactVersionRow } from '../../db-types/artifacts.js';
import { buildArtifactRenderHtml, injectLiveToolbar } from '../../routes/artifacts.js';
import type { LiveRenderConfig } from '../../routes/artifacts.js';

const BASE = '/api/admin/artifacts';

function rowToPublic(row: ArtifactRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    version: row.version,
    session_id: row.session_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    run_id: row.run_id,
    tags: row.tags ? (() => { try { return JSON.parse(row.tags!); } catch { return []; } })() : [],
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata!); } catch { return {}; } })() : {},
    policy_id: row.policy_id,
    scope: row.scope,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function versionRowToPublic(row: ArtifactVersionRow) {
  return {
    id: row.id,
    artifact_id: row.artifact_id,
    version: row.version,
    changelog: row.changelog,
    created_at: row.created_at,
  };
}

export function registerArtifactRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    try { return JSON.parse(await readBody(req) || '{}') as Record<string, unknown>; }
    catch { return {}; }
  }

  // ── Create artifact (admin — for seeding test data, direct agent output) ────
  router.post(BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.saveArtifact) { json(res, 501, { error: 'Artifact storage not available' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>; }
    catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const name = (body['name'] as string | undefined) ?? 'admin-artifact';
    const type = (body['type'] as string | undefined) ?? 'text';
    const mimeType = (body['mimeType'] as string | undefined) ?? (body['mime_type'] as string | undefined) ?? 'text/plain';
    const data = (body['data'] as string | undefined) ?? '';
    const scope = ((body['scope'] as string | undefined) ?? 'session') as 'session' | 'user';
    const userId = (body['userId'] as string | undefined) ?? (body['user_id'] as string | undefined) ?? auth.userId ?? undefined;
    const row = await db.saveArtifact({ name, type, mimeType, data, scope, userId });
    json(res, 201, { artifact: rowToPublic(row) });
  });

  // ── List artifacts ──────────────────────────────────────────────────────────
  router.get(BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const type = url.searchParams.get('type') ?? undefined;
    const sessionId = url.searchParams.get('session_id') ?? undefined;
    const userId = url.searchParams.get('user_id') ?? undefined;
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    const runId = url.searchParams.get('run_id') ?? undefined;
    const scope = url.searchParams.get('scope') as 'session' | 'user' | undefined ?? undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const sqliteDb = (db as unknown as { listArtifacts?: typeof db.listArtifacts }).listArtifacts;
    if (!sqliteDb) { json(res, 501, { error: 'Artifact storage not available' }); return; }
    // Tenant scoping: tenant_admin sees only their tenant's artifacts
    const isPlatformAdmin = auth.persona === 'platform_admin';
    const tenantId: string | null | undefined = isPlatformAdmin
      ? (url.searchParams.has('tenantId') ? (url.searchParams.get('tenantId') ?? null) : undefined)
      : (auth.tenantId ?? null);
    const rows = await db.listArtifacts!({ type, sessionId, userId, agentId, runId, scope, limit, offset, tenantId });
    json(res, 200, { artifacts: rows.map(rowToPublic), total: rows.length, limit, offset });
  });

  // ── Get single artifact ──────────────────────────────────────────────────────
  router.get(`${BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getArtifact!(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    if (auth.persona !== 'platform_admin' && row.tenant_id !== null && row.tenant_id !== auth.tenantId) {
      json(res, 403, { error: 'Forbidden' }); return;
    }
    json(res, 200, { artifact: rowToPublic(row) });
  });

  // ── Get artifact versions ────────────────────────────────────────────────────
  router.get(`${BASE}/:id/versions`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getArtifact!(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    if (auth.persona !== 'platform_admin' && row.tenant_id !== null && row.tenant_id !== auth.tenantId) {
      json(res, 403, { error: 'Forbidden' }); return;
    }
    const versions = await db.getArtifactVersions!(params['id'] ?? '');
    json(res, 200, { versions: versions.map(versionRowToPublic) });
  });

  // ── Get specific version ─────────────────────────────────────────────────────
  router.get(`${BASE}/:id/versions/:version`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const v = parseInt(params['version'] ?? '1', 10);
    const row = await db.getArtifactVersion!(params['id'] ?? '', v);
    if (!row) { json(res, 404, { error: 'Version not found' }); return; }
    json(res, 200, { version: versionRowToPublic(row) });
  });

  // ── Download artifact data ───────────────────────────────────────────────────
  router.get(`${BASE}/:id/download`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getArtifact!(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    const data = deserializeArtifactData(row.data_text, row.data_blob);
    const ext = mimeToExt(row.mime_type);
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeName(row.name)}.${ext}"`);
    if (Buffer.isBuffer(data)) {
      res.writeHead(200);
      res.end(data);
    } else if (typeof data === 'string') {
      res.writeHead(200);
      res.end(data, 'utf8');
    } else {
      res.writeHead(200);
      res.end(JSON.stringify(data, null, 2), 'utf8');
    }
  });

  // ── Phase 7: Download specific version ──────────────────────────────────────
  router.get(`${BASE}/:id/versions/:n/download`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getArtifactVersion) { json(res, 501, { error: 'Artifact storage not available' }); return; }
    const row = await db.getArtifact(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    const n = parseInt(params['n'] ?? '0', 10);
    if (isNaN(n) || n < 1) { json(res, 400, { error: 'Invalid version number' }); return; }
    const ver = await db.getArtifactVersion(params['id'] ?? '', n);
    if (!ver) { json(res, 404, { error: `Version ${n} not found` }); return; }
    const ext = mimeToExt(row.mime_type);
    const fn = `${sanitizeName(row.name)}_v${n}.${ext}`;
    const data = deserializeArtifactData(ver.data_text, ver.data_blob);
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (Buffer.isBuffer(data)) {
      res.writeHead(200);
      res.end(data);
    } else if (typeof data === 'string') {
      res.writeHead(200);
      res.end(data, 'utf8');
    } else {
      res.writeHead(200);
      res.end(JSON.stringify(data, null, 2), 'utf8');
    }
  });

  // ── Phase 5: Render artifact as sandboxed HTML for admin preview ─────────────
  router.get(`${BASE}/:id/render`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getArtifact!(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    const meta = (() => { try { return JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
    const language = (meta['language'] as string | undefined) ?? '';
    const html = buildArtifactRenderHtml(
      row.type, row.data_text ?? '', row.mime_type, row.name, language, params['id']!,
    );
    const csp = [
      "default-src 'none'", "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
    ].join('; ');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.writeHead(200);
    res.end(html);
  });

  // ── Phase 6: Live config CRUD (admin) ────────────────────────────────────────
  //
  // GET    /api/admin/artifacts/:id/live-config  — read live config
  // POST   /api/admin/artifacts/:id/live-config  — create / upsert live config
  // PATCH  /api/admin/artifacts/:id/live-config  — update fields
  // DELETE /api/admin/artifacts/:id/live-config  — remove live config (make static)
  // POST   /api/admin/artifacts/:id/live-refresh — admin-triggered refresh

  router.get(`${BASE}/:id/live-config`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getLiveArtifactConfig) { json(res, 501, { error: 'Live artifact storage not available' }); return; }
    const row = await db.getLiveArtifactConfig(params['id'] ?? '');
    if (!row) { json(res, 404, { error: 'No live config for this artifact' }); return; }
    json(res, 200, { liveConfig: row });
  });

  router.post(`${BASE}/:id/live-config`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.saveLiveArtifactConfig || !db.getArtifact) { json(res, 501, { error: 'Live artifact storage not available' }); return; }
    const artifactId = params['id'] ?? '';
    const existing = await db.getArtifact(artifactId);
    if (!existing) { json(res, 404, { error: 'Artifact not found' }); return; }
    const body = await readJson(req);
    const row = await db.saveLiveArtifactConfig({
      artifactId,
      mcpServerKey: body['mcpServerKey'] as string | undefined,
      refreshTool: body['refreshTool'] as string | undefined,
      refreshArgs: body['refreshArgs'] as Record<string, unknown> | undefined,
      refreshIntervalSeconds: typeof body['refreshIntervalSeconds'] === 'number' ? body['refreshIntervalSeconds'] : 0,
      cacheTtlSeconds: typeof body['cacheTtlSeconds'] === 'number' ? body['cacheTtlSeconds'] : 30,
    });
    json(res, 201, { liveConfig: row });
  });

  router.patch(`${BASE}/:id/live-config`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.updateLiveArtifactConfig || !db.getLiveArtifactConfig) { json(res, 501, { error: 'Live artifact storage not available' }); return; }
    const artifactId = params['id'] ?? '';
    const existing = await db.getLiveArtifactConfig(artifactId);
    if (!existing) { json(res, 404, { error: 'No live config for this artifact' }); return; }
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    if ('mcpServerKey' in body) patch['mcpServerKey'] = body['mcpServerKey'];
    if ('refreshTool' in body) patch['refreshTool'] = body['refreshTool'];
    if ('refreshArgs' in body) patch['refreshArgs'] = body['refreshArgs'];
    if ('refreshIntervalSeconds' in body) patch['refreshIntervalSeconds'] = body['refreshIntervalSeconds'];
    if ('cacheTtlSeconds' in body) patch['cacheTtlSeconds'] = body['cacheTtlSeconds'];
    const row = await db.updateLiveArtifactConfig(artifactId, patch as import('../../db-types/artifacts.js').LiveArtifactConfigUpdate);
    json(res, 200, { liveConfig: row });
  });

  router.del(`${BASE}/:id/live-config`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.deleteLiveArtifactConfig || !db.getLiveArtifactConfig) { json(res, 501, { error: 'Live artifact storage not available' }); return; }
    const artifactId = params['id'] ?? '';
    const existing = await db.getLiveArtifactConfig(artifactId);
    if (!existing) { json(res, 404, { error: 'No live config for this artifact' }); return; }
    await db.deleteLiveArtifactConfig(artifactId);
    json(res, 200, { ok: true });
  });

  router.post(`${BASE}/:id/live-refresh`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.touchLiveArtifactRefresh || !db.getLiveArtifactConfig || !db.getArtifact) {
      json(res, 501, { error: 'Live artifact storage not available' }); return;
    }
    const artifactId = params['id'] ?? '';
    const artifact = await db.getArtifact(artifactId);
    if (!artifact) { json(res, 404, { error: 'Artifact not found' }); return; }
    const liveConfig = await db.getLiveArtifactConfig(artifactId);
    if (!liveConfig) { json(res, 404, { error: 'Artifact is not configured as live' }); return; }
    await db.touchLiveArtifactRefresh(artifactId);
    json(res, 200, { ok: true, artifactId, refreshedAt: new Date().toISOString() });
  });

  // ── Admin render (Phase 5 + Phase 6 toolbar) ─────────────────────────────────
  //
  // Replaces the earlier Phase-5-only render route above.

  router.get(`${BASE}/:id/render-live`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const artifactId = params['id'] ?? '';
    const row = await db.getArtifact!(artifactId);
    if (!row) { json(res, 404, { error: 'Artifact not found' }); return; }
    const meta = (() => { try { return JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
    const language = (meta['language'] as string | undefined) ?? '';
    const liveConfig = db.getLiveArtifactConfig ? await db.getLiveArtifactConfig(artifactId) : null;
    const liveParam: LiveRenderConfig | undefined = liveConfig ? {
      artifactId,
      refreshIntervalSeconds: liveConfig.refresh_interval_seconds,
      lastRefreshedAt: liveConfig.last_refreshed_at,
      refreshCount: liveConfig.refresh_count,
      refreshEndpoint: `/api/artifacts/${artifactId}/refresh`,
    } : undefined;
    let html = buildArtifactRenderHtml(row.type, row.data_text ?? '', row.mime_type, row.name, language, artifactId);
    if (liveParam) html = injectLiveToolbar(html, liveParam);
    const csp = [
      "default-src 'none'", "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
      ...(liveParam ? ["connect-src 'self'"] : []),
    ].join('; ');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.writeHead(200);
    res.end(html);
  });

  // ── Delete artifact ──────────────────────────────────────────────────────────
  router.del(`${BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getArtifact!(params['id'] ?? '');
    if (!existing) { json(res, 404, { error: 'Artifact not found' }); return; }
    if (auth.persona !== 'platform_admin' && existing.tenant_id !== null && existing.tenant_id !== auth.tenantId) {
      json(res, 403, { error: 'Forbidden' }); return;
    }
    await db.deleteArtifact!(params['id'] ?? '');
    json(res, 200, { ok: true });
  });
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_\-. ]/gi, '_').slice(0, 80);
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'text/html': 'html',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'text/typescript': 'ts',
    'text/javascript': 'js',
    'text/x-python': 'py',
    'application/sql': 'sql',
    'text/x-mermaid': 'mmd',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
  };
  return map[mime] ?? 'bin';
}
