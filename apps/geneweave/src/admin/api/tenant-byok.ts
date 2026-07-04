/**
 * @weaveintel/geneweave — Phase 10 BYOK / HYOK / break-glass / attestation admin routes.
 *
 * Thin HTTP surface over `apps/geneweave/src/encryption/byok-service.ts`. All
 * lifecycle state lives in the database; this module just validates input,
 * delegates, and serialises the result. No cryptographic logic here.
 *
 * Reusability: the only geneweave-specific dependency is the `DatabaseAdapter`
 * import. Other apps can register the same routes by passing their adapter.
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import type { DatabaseAdapter } from '../../db.js';
import {
  upsertByokConfig,
  revokeByokConfig,
  requestBreakGlass,
  approveBreakGlassById,
  denyBreakGlassById,
  reapExpiredBreakGlassRequests,
  getActiveBreakGlassGrant,
  buildAttestationForTenant,
  getAttestationPublicKey,
} from '../../encryption/byok-service.js';
import {
  createByokImportSession,
  consumeByokImportSession,
} from '../../byok-import-session.js';
import type { RouterLike } from './types.js';

export interface ByokRouteHelpers {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function registerTenantByokRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: ByokRouteHelpers,
): void {
  const { json, readBody } = helpers;

  // ── BYOK / HYOK config CRUD ───────────────────────────────────

  router.post('/api/admin/byok/config', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = asStr(body['tenant_id'] ?? body['tenantId']);
    const publicKeyPem = asStr(body['public_key_pem'] ?? body['publicKeyPem']);
    if (!tenantId) { json(res, 400, { error: 'tenant_id required' }); return; }
    if (!publicKeyPem) { json(res, 400, { error: 'public_key_pem required' }); return; }
    const modeRaw = asStr(body['mode']);
    const mode = modeRaw === 'hyok' || modeRaw === 'byok' ? modeRaw : undefined;

    // ── Reject legacy dev-only field in production ───────────────────────────
    const rawDevKey = body['private_key_pem_dev'] ?? body['privateKeyPemDev'];
    if (rawDevKey !== undefined && rawDevKey !== null && rawDevKey !== '' && process.env['NODE_ENV'] === 'production') {
      json(res, 400, { error: 'private_key_pem_dev is not permitted in production. Use POST /api/admin/byok/import-session to obtain a wrapped key import ceremony instead.' });
      return;
    }

    // ── Production import: unwrap the private key from a key-import session ──
    let unwrappedPrivateKeyPem: string | null = null;
    const importSessionId = asStr(body['import_session_id'] ?? body['importSessionId']);
    const wrappedPrivateKey = asStr(body['wrapped_private_key'] ?? body['wrappedPrivateKey']);
    if (importSessionId && wrappedPrivateKey) {
      unwrappedPrivateKeyPem = consumeByokImportSession(importSessionId, wrappedPrivateKey);
      if (!unwrappedPrivateKeyPem) {
        json(res, 400, { error: 'Invalid, expired, or already-used import session. Request a new session via POST /api/admin/byok/import-session.' });
        return;
      }
    }

    try {
      const out = await upsertByokConfig(db, {
        tenantId,
        publicKeyPem,
        ...(mode ? { mode } : {}),
        hyokEndpoint: asStr(body['hyok_endpoint'] ?? body['hyokEndpoint']),
        hyokBearerSecretId: asStr(body['hyok_bearer_secret_id'] ?? body['hyokBearerSecretId']),
        hyokTimeoutMs: typeof body['hyok_timeout_ms'] === 'number' ? (body['hyok_timeout_ms'] as number) : null,
        // privateKeyPemDev is accepted only in non-production. In production, use
        // the import session flow above (unwrappedPrivateKeyPem takes precedence).
        privateKeyPemDev: unwrappedPrivateKeyPem ?? (process.env['NODE_ENV'] !== 'production' ? asStr(rawDevKey) : undefined),
        createdBy: auth.userId ?? null,
      });
      json(res, 200, out);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  // ── Key-import ceremony ───────────────────────────────────────────────────
  // Step 1: obtain an ephemeral public key to wrap the BYOK private key client-side.
  // Step 2: POST /api/admin/byok/config with { importSessionId, wrappedPrivateKey }.
  router.post('/api/admin/byok/import-session', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    // RSA-4096 key generation is CPU-bound (~200–400ms). This is acceptable for a
    // privileged, rare operation. Do not call this on a hot path.
    const session = createByokImportSession();
    json(res, 200, {
      sessionId: session.sessionId,
      ephemeralPublicKeyPem: session.ephemeralPublicKeyPem,
      algorithm: session.algorithm,
      modulusLengthBits: session.modulusLengthBits,
      expiresAt: session.expiresAt,
      instructions: [
        '1. Encrypt your BYOK private key (PEM bytes, UTF-8) with the ephemeralPublicKeyPem',
        '   using RSA-OAEP with SHA-256 as the hash function.',
        '2. Base64-encode the ciphertext → wrappedPrivateKey.',
        '3. POST /api/admin/byok/config with { importSessionId, wrappedPrivateKey, publicKeyPem, tenantId }.',
        '   The session expires in 15 minutes and is single-use.',
      ],
    });
  }, { auth: true, csrf: true });

  router.get('/api/admin/byok/config', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantByokConfigs();
    json(res, 200, { configs: rows });
  }, { auth: true });

  router.get('/api/admin/byok/config/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getTenantByokConfig(params['tenantId']!);
    if (!row) { json(res, 404, { error: 'Not found' }); return; }
    json(res, 200, row);
  }, { auth: true });

  router.del('/api/admin/byok/config/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const ok = await revokeByokConfig(db, params['tenantId']!, auth.userId ?? null);
    json(res, ok ? 200 : 404, { revoked: ok });
  }, { auth: true, csrf: true });

  // ── Break-glass workflow ──────────────────────────────────────

  router.post('/api/admin/byok/break-glass/request', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = asStr(body['tenant_id'] ?? body['tenantId']);
    const reason = asStr(body['reason']);
    if (!tenantId || !reason) { json(res, 400, { error: 'tenant_id and reason required' }); return; }
    try {
      const row = await requestBreakGlass(db, {
        tenantId,
        requestedBy: auth.userId ?? 'unknown',
        reason,
        ...(typeof body['window_ms'] === 'number' ? { windowMs: body['window_ms'] as number } : {}),
      });
      json(res, 200, row);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/byok/break-glass/:id/approve', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const approver = asStr(body['customer_approver']) ?? auth.userId ?? null;
    if (!approver) { json(res, 400, { error: 'customer_approver required' }); return; }
    try {
      const row = await approveBreakGlassById(db, params['id']!, approver);
      if (!row) { json(res, 404, { error: 'Not found' }); return; }
      json(res, 200, row);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/byok/break-glass/:id/deny', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const note = asStr(body['note']) ?? '';
    const deniedBy = asStr(body['denied_by']) ?? auth.userId ?? 'unknown';
    try {
      const row = await denyBreakGlassById(db, params['id']!, deniedBy, note);
      if (!row) { json(res, 404, { error: 'Not found' }); return; }
      json(res, 200, row);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.get('/api/admin/byok/break-glass', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://_');
    const tenantId = url.searchParams.get('tenant_id') ?? undefined;
    const status = url.searchParams.get('status') as 'pending' | 'approved' | 'denied' | 'expired' | null;
    const rows = await db.listBreakGlassRequests({
      ...(tenantId ? { tenantId } : {}),
      ...(status ? { status } : {}),
    });
    json(res, 200, { requests: rows });
  }, { auth: true });

  router.get('/api/admin/byok/break-glass/active/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const grant = await getActiveBreakGlassGrant(db, params['tenantId']!);
    json(res, 200, { grant });
  }, { auth: true });

  router.post('/api/admin/byok/break-glass/reap', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const count = await reapExpiredBreakGlassRequests(db);
    json(res, 200, { reaped: count });
  }, { auth: true, csrf: true });

  // ── Attestation export + verification key ─────────────────────

  router.post('/api/admin/byok/attestation/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const host = req.headers['host'] ?? 'geneweave';
    try {
      const out = await buildAttestationForTenant(db, {
        tenantId: params['tenantId']!,
        host: typeof host === 'string' ? host : 'geneweave',
        requestedBy: auth.userId ?? null,
      });
      json(res, 200, out);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.get('/api/admin/byok/attestation/public-key', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const out = await getAttestationPublicKey(db);
    json(res, 200, out);
  }, { auth: true });

  router.get('/api/admin/byok/attestation/log/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://_');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const rows = await db.listAttestationLogs({ tenantId: params['tenantId']!, limit: Number.isFinite(limit) ? limit : 50 });
    json(res, 200, { attestations: rows });
  }, { auth: true });
}
