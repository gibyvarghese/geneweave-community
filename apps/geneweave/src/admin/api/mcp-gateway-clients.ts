/**
 * @weaveintel/geneweave — Admin MCP Gateway Client routes (Phase 5)
 *
 * CRUD endpoints for per-client MCP gateway bearer tokens. Each client row
 * stores only the SHA-256 digest of the token, never the plaintext. The
 * mint flow returns the freshly generated plaintext exactly once on create
 * (or rotate); callers must capture it then. After that the gateway can
 * verify presented tokens by hashing them and looking up the row.
 *
 * The list/get responses never include the plaintext — only the digest, the
 * scope, the audit chatId, and the timestamps.
 */

import { randomBytes } from 'node:crypto';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { hashGatewayToken } from '../../mcp-gateway.js';

/** Generate a cryptographically random 32-byte bearer token, hex-encoded. */
function mintToken(): string {
  return randomBytes(32).toString('hex');
}

export function registerMCPGatewayClientRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ── List ───────────────────────────────────────────────────
  router.get('/api/admin/mcp-gateway-clients', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const clients = await db.listMCPGatewayClients();
    json(res, 200, { clients });
  }, { auth: true });

  // ── Get by ID ──────────────────────────────────────────────
  router.get('/api/admin/mcp-gateway-clients/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const client = await db.getMCPGatewayClient(params['id']!);
    if (!client) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    json(res, 200, { client });
  }, { auth: true });

  // ── Create ─────────────────────────────────────────────────
  // Body: { name, description?, allowed_classes?: string[], audit_chat_id?, enabled? }
  // Response 201: { client, token } — the plaintext token is returned
  // exactly once and never persisted. Operators must capture it.
  router.post('/api/admin/mcp-gateway-clients', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0) {
      json(res, 400, { error: 'name required' }); return;
    }
    const allowedRaw = body['allowed_classes'];
    let allowed_classes: string | null = null;
    if (allowedRaw !== undefined && allowedRaw !== null) {
      allowed_classes = typeof allowedRaw === 'string' ? allowedRaw : JSON.stringify(allowedRaw);
    }
    const id = newUUIDv7();
    const plaintext = mintToken();
    const rlRaw = body['rate_limit_per_minute'];
    let rate_limit_per_minute: number | null = null;
    if (typeof rlRaw === 'number' && Number.isFinite(rlRaw) && rlRaw > 0) {
      rate_limit_per_minute = Math.floor(rlRaw);
    }
    // Phase 9: optional expires_at. Accepts either an ISO 8601 timestamp
    // string or a numeric "days from now" shortcut for ergonomics in the
    // admin UI's create form.
    const expRaw = body['expires_at'];
    let expires_at: string | null = null;
    if (typeof expRaw === 'string' && expRaw.length > 0) {
      const parsed = new Date(expRaw);
      if (Number.isNaN(parsed.getTime())) {
        json(res, 400, { error: 'expires_at must be a valid ISO 8601 timestamp' });
        return;
      }
      expires_at = parsed.toISOString();
    } else if (typeof expRaw === 'number' && Number.isFinite(expRaw) && expRaw > 0) {
      expires_at = new Date(Date.now() + Math.floor(expRaw) * 86_400_000).toISOString();
    }
    await db.createMCPGatewayClient({
      id,
      name,
      description: (body['description'] as string) ?? null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes,
      audit_chat_id: (body['audit_chat_id'] as string) ?? null,
      enabled: body['enabled'] === false ? 0 : 1,
      rate_limit_per_minute,
      expires_at,
      rotated_at: null,
    });
    const client = await db.getMCPGatewayClient(id);
    json(res, 201, { client, token: plaintext });
  }, { auth: true, csrf: true });

  // ── Update ─────────────────────────────────────────────────
  // Token rotation is intentionally NOT part of update — use the dedicated
  // /:id/rotate action so operators have an explicit audit trail of when
  // the secret changed.
  router.put('/api/admin/mcp-gateway-clients/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['allowed_classes'] !== undefined) {
      fields['allowed_classes'] = body['allowed_classes'] === null
        ? null
        : (typeof body['allowed_classes'] === 'string'
          ? body['allowed_classes']
          : JSON.stringify(body['allowed_classes']));
    }
    if (body['audit_chat_id'] !== undefined) fields['audit_chat_id'] = body['audit_chat_id'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['rate_limit_per_minute'] !== undefined) {
      const v = body['rate_limit_per_minute'];
      if (v === null) {
        fields['rate_limit_per_minute'] = null;
      } else if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        fields['rate_limit_per_minute'] = Math.floor(v);
      } else {
        json(res, 400, { error: 'rate_limit_per_minute must be a positive number or null' });
        return;
      }
    }
    // Phase 9: expires_at update. null clears the expiry, ISO string sets
    // it, numeric "days from now" is a convenience shortcut for the UI.
    if (body['expires_at'] !== undefined) {
      const v = body['expires_at'];
      if (v === null) {
        fields['expires_at'] = null;
      } else if (typeof v === 'string' && v.length > 0) {
        const parsed = new Date(v);
        if (Number.isNaN(parsed.getTime())) {
          json(res, 400, { error: 'expires_at must be a valid ISO 8601 timestamp' });
          return;
        }
        fields['expires_at'] = parsed.toISOString();
      } else if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        fields['expires_at'] = new Date(Date.now() + Math.floor(v) * 86_400_000).toISOString();
      } else {
        json(res, 400, { error: 'expires_at must be ISO timestamp, days-from-now number, or null' });
        return;
      }
    }
    await db.updateMCPGatewayClient(params['id']!, fields as Parameters<DatabaseAdapter['updateMCPGatewayClient']>[1]);
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client });
  }, { auth: true, csrf: true });

  // ── Delete ─────────────────────────────────────────────────
  router.del('/api/admin/mcp-gateway-clients/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMCPGatewayClient(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Revoke action ──────────────────────────────────────────
  // Soft-delete: sets enabled=0 and revoked_at; keeps the row for audit.
  router.post('/api/admin/mcp-gateway-clients/:id/revoke', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    await db.revokeMCPGatewayClient(params['id']!);
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client });
  }, { auth: true, csrf: true });

  // ── Rotate action ──────────────────────────────────────────
  // Mints a fresh bearer token, replaces the stored hash, stamps
  // rotated_at, and (Phase 9) optionally extends expires_at via the body.
  // Returns the new plaintext exactly once. The previous token immediately
  // stops working on the next gateway request.
  router.post('/api/admin/mcp-gateway-clients/:id/rotate', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    // Body is optional. When provided it can carry expires_at to extend
    // the token's lifetime atomically with the rotation.
    let expiresAtUpdate: string | null | undefined = undefined;
    try {
      const raw = await readBody(req);
      if (raw && raw.length > 0) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const v = body['expires_at'];
        if (v === null) {
          expiresAtUpdate = null;
        } else if (typeof v === 'string' && v.length > 0) {
          const parsed = new Date(v);
          if (Number.isNaN(parsed.getTime())) {
            json(res, 400, { error: 'expires_at must be a valid ISO 8601 timestamp' });
            return;
          }
          expiresAtUpdate = parsed.toISOString();
        } else if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          expiresAtUpdate = new Date(Date.now() + Math.floor(v) * 86_400_000).toISOString();
        }
      }
    } catch { /* empty body — proceed with rotation only */ }
    const plaintext = mintToken();
    const updateFields: Record<string, unknown> = {
      token_hash: hashGatewayToken(plaintext),
      rotated_at: new Date().toISOString(),
    };
    if (expiresAtUpdate !== undefined) updateFields['expires_at'] = expiresAtUpdate;
    await db.updateMCPGatewayClient(
      params['id']!,
      updateFields as Parameters<DatabaseAdapter['updateMCPGatewayClient']>[1],
    );
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client, token: plaintext });
  }, { auth: true, csrf: true });

  // ── Phase 9: Expiring-soon listing ────────────────────────
  // Surfaces enabled clients whose expires_at is within the operator-
  // supplied window (default 7 days). Powers the admin dashboard nudge
  // to rotate before traffic starts being rejected.
  router.get('/api/admin/mcp-gateway-clients/expiring-soon', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const daysParam = url.searchParams.get('days');
    const days = daysParam !== null && Number.isFinite(Number(daysParam)) && Number(daysParam) > 0
      ? Math.min(365, Math.floor(Number(daysParam)))
      : 7;
    const clients = await db.listExpiringMCPGatewayClients(days * 86_400);
    json(res, 200, { window_days: days, clients });
  }, { auth: true });
}
