/**
 * @weaveintel/geneweave — Admin Tenant Encryption Policy routes
 *
 * Tenant Encryption Phase 2. CRUD over `tenant_encryption_policy` plus the
 * four operator lifecycle actions exposed by `@weaveintel/encryption`'s
 * `TenantKeyManager`: bootstrap, rotate-dek, rotate-kek, shred. Read-only
 * `keys` and `audit` endpoints surface the per-tenant key inventory + audit
 * log without ever exposing wrapped key material.
 *
 * Wired to the live process-wide `geneweaveEncryptionManager` via a getter
 * (avoids importing the mutable `let` directly). Lifecycle actions return
 * 503 when the manager is null (i.e. `WEAVE_ENCRYPTION_MASTER_KEY` was not
 * set at boot). Read endpoints work without a manager.
 *
 * Reusability: any consumer app can register this route module by supplying
 * its own `EncryptionStore`-backed DB adapter and a getter for its own
 * TenantKeyManager. The route file depends on `DatabaseAdapter` and
 * `EncryptionStore` only.
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  CachedKmsResolver,
  KmsProviderRegistry,
  TenantKeyManager,
} from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../../db.js';
import { createDbEncryptionStore } from '../../encryption/db-encryption-store.js';
import type { RouterLike } from './types.js';

export interface TenantEncryptionRouteHelpers {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
}

/** Getter so the route captures the current value of a process-wide mutable manager (post-boot wiring). */
export type GetEncryptionManager = () => TenantKeyManager | null;
/** Phase 7: getter for the KMS provider registry (for validation + health-check). */
export type GetKmsRegistry = () => KmsProviderRegistry | null;
/** Phase 7: getter for the cached resolver (used to invalidate after policy edits). */
export type GetKmsResolver = () => CachedKmsResolver | null;

const VALID_ROTATION_SCHEDULES = new Set(['manual', 'monthly', 'quarterly', 'annual']);

function asBoolFlag(v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'string') return v === 'true' || v === '1' ? 1 : 0;
  return fallback;
}

function parseJsonField(raw: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: true, value: null };
    try { JSON.parse(raw); } catch { return { ok: false, error: `${label} must be valid JSON` }; }
    return { ok: true, value: raw };
  }
  if (typeof raw === 'object') return { ok: true, value: JSON.stringify(raw) };
  return { ok: false, error: `${label} must be a JSON object or stringified JSON` };
}

/** Drop `wrapped` (raw key material) from any record before returning over the wire. */
function sanitize<T extends { wrapped?: unknown }>(rec: T): Omit<T, 'wrapped'> {
  const { wrapped: _w, ...rest } = rec;
  return rest;
}

export function registerTenantEncryptionPolicyRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: TenantEncryptionRouteHelpers,
  getEncryptionManager: GetEncryptionManager,
  getKmsRegistry: GetKmsRegistry = () => null,
  getKmsResolver: GetKmsResolver = () => null,
): void {
  const { json, readBody } = helpers;
  const delMethod = router.del.bind(router);
  const store = createDbEncryptionStore(db);

  /**
   * Validates a `kms_provider_id` against the live registry. Returns null on
   * success, or an error message string. When the registry is not wired
   * (legacy bootstrap), validation is skipped.
   */
  function validateProviderId(id: string): string | null {
    const registry = getKmsRegistry();
    if (!registry) return null;
    if (!registry.has(id)) {
      return `Unknown kms_provider_id '${id}'. Registered: [${registry.list().join(', ')}]`;
    }
    return null;
  }

  // ── Phase 7: KMS provider catalog + health-check ──────────

  router.get('/api/admin/encryption/kms-providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const registry = getKmsRegistry();
    if (!registry) { json(res, 503, { error: 'KMS registry not initialized' }); return; }
    json(res, 200, { providers: registry.list() });
  }, { auth: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/kms/health-check', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const registry = getKmsRegistry();
    const resolver = getKmsResolver();
    if (!registry || !resolver) { json(res, 503, { error: 'KMS registry/resolver not initialized' }); return; }
    const tenantId = params['tenantId']!;
    const policy = await db.getTenantEncryptionPolicy(tenantId);
    if (!policy) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    let provider;
    try {
      provider = await resolver.resolve(tenantId);
    } catch (err) {
      json(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const status = await registry.healthCheck(policy.kms_provider_id, provider);
    // Persist a single audit row so operators can see when checks ran.
    try {
      await db.insertEncryptionAudit({
        id: randomUUID(),
        tenant_id: tenantId,
        event_kind: 'kms_health_check',
        actor: (auth.userId) ?? null,
        details: JSON.stringify({
          providerId: status.providerId,
          ok: status.ok,
          ...(status.latencyMs !== undefined ? { latencyMs: status.latencyMs } : {}),
          ...(status.error ? { error: status.error } : {}),
        }),
        created_at: Date.now(),
      });
    } catch {
      /* audit best-effort */
    }
    json(res, status.ok ? 200 : 502, status);
  }, { auth: true, csrf: true });

  // ── List + read ────────────────────────────────────────────

  router.get('/api/admin/tenant-encryption-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listTenantEncryptionPolicies();
    const managerAvailable = getEncryptionManager() !== null;
    json(res, 200, { policies, manager_available: managerAvailable });
  }, { auth: true });

  router.get('/api/admin/tenant-encryption-policies/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const policy = await db.getTenantEncryptionPolicy(tenantId);
    if (!policy) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    const [keks, deks, biks] = await Promise.all([store.listKeks(tenantId), store.listDeks(tenantId), store.listBiks(tenantId)]);
    json(res, 200, {
      policy,
      key_counts: { keks: keks.length, deks: deks.length, biks: biks.length },
      manager_available: getEncryptionManager() !== null,
    });
  }, { auth: true });

  // ── Create + update ───────────────────────────────────────
  // POST is upsert-by-tenant_id. If body sets enabled=true and a key
  // manager is available, we auto-bootstrap so the row arrives with
  // active KEK+DEK ready to use.

  router.post('/api/admin/tenant-encryption-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const tenantId = body['tenant_id'];
    if (typeof tenantId !== 'string' || !tenantId.trim()) {
      json(res, 400, { error: 'tenant_id required' }); return;
    }
    if (await db.getTenantEncryptionPolicy(tenantId)) {
      json(res, 409, { error: 'Tenant encryption policy already exists (use PUT to update)' }); return;
    }
    const rotationSchedule = (body['rotation_schedule'] as string) ?? 'manual';
    if (!VALID_ROTATION_SCHEDULES.has(rotationSchedule)) {
      json(res, 400, { error: `rotation_schedule must be one of ${[...VALID_ROTATION_SCHEDULES].join(', ')}` }); return;
    }
    const fieldPolicy = parseJsonField(body['field_policy'], 'field_policy');
    if (!fieldPolicy.ok) { json(res, 400, { error: fieldPolicy.error }); return; }
    const kmsConfig = parseJsonField(body['kms_config'], 'kms_config');
    if (!kmsConfig.ok) { json(res, 400, { error: kmsConfig.error }); return; }

    const enabled = asBoolFlag(body['enabled'], 0);
    const providerId = typeof body['kms_provider_id'] === 'string' ? (body['kms_provider_id'] as string) : 'local';
    const providerErr = validateProviderId(providerId);
    if (providerErr) { json(res, 400, { error: providerErr }); return; }
    await db.upsertTenantEncryptionPolicy({
      tenant_id: tenantId,
      enabled,
      kms_provider_id: providerId,
      kms_config: kmsConfig.value,
      active_kek_id: null,
      active_dek_id: null,
      active_bik_id: null,
      rotation_schedule: rotationSchedule,
      blind_index_enabled: asBoolFlag(body['blind_index_enabled'], 0),
      field_policy: fieldPolicy.value ?? '{}',
      shred_requested_at: null,
      shred_completed_at: null,
    });
    getKmsResolver()?.invalidate(tenantId);

    let bootstrapped = false;
    let bootstrapReason: string | undefined;
    const km = getEncryptionManager();
    if (enabled === 1 && km) {
      try {
        await km.bootstrapTenant({ tenantId, enable: true, ...(auth.userId ? { actor: auth.userId } : {}) });
        bootstrapped = true;
      } catch (err) {
        bootstrapReason = `bootstrap_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (enabled === 1 && !km) {
      bootstrapReason = 'manager_unavailable: WEAVE_ENCRYPTION_MASTER_KEY not configured';
    }

    const policy = await db.getTenantEncryptionPolicy(tenantId);
    json(res, 201, { policy, bootstrapped, ...(bootstrapReason ? { bootstrap_reason: bootstrapReason } : {}) });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tenant-encryption-policies/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const existing = await db.getTenantEncryptionPolicy(tenantId);
    if (!existing) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    if (body['rotation_schedule'] !== undefined && !VALID_ROTATION_SCHEDULES.has(body['rotation_schedule'] as string)) {
      json(res, 400, { error: `rotation_schedule must be one of ${[...VALID_ROTATION_SCHEDULES].join(', ')}` }); return;
    }
    let fieldPolicyValue: string | null | undefined;
    if (body['field_policy'] !== undefined) {
      const r = parseJsonField(body['field_policy'], 'field_policy');
      if (!r.ok) { json(res, 400, { error: r.error }); return; }
      fieldPolicyValue = r.value ?? '{}';
    }
    let kmsConfigValue: string | null | undefined;
    if (body['kms_config'] !== undefined) {
      const r = parseJsonField(body['kms_config'], 'kms_config');
      if (!r.ok) { json(res, 400, { error: r.error }); return; }
      kmsConfigValue = r.value;
    }

    const wasEnabled = existing.enabled === 1;
    const nextEnabled = body['enabled'] !== undefined ? asBoolFlag(body['enabled'], existing.enabled) : existing.enabled;
    const nextProviderId = typeof body['kms_provider_id'] === 'string' ? (body['kms_provider_id'] as string) : existing.kms_provider_id;
    if (nextProviderId !== existing.kms_provider_id) {
      const providerErr = validateProviderId(nextProviderId);
      if (providerErr) { json(res, 400, { error: providerErr }); return; }
    }

    await db.upsertTenantEncryptionPolicy({
      tenant_id: tenantId,
      enabled: nextEnabled,
      kms_provider_id: nextProviderId,
      kms_config: kmsConfigValue !== undefined ? kmsConfigValue : existing.kms_config,
      active_kek_id: existing.active_kek_id,
      active_dek_id: existing.active_dek_id,
      active_bik_id: existing.active_bik_id,
      rotation_schedule: typeof body['rotation_schedule'] === 'string' ? (body['rotation_schedule'] as string) : existing.rotation_schedule,
      blind_index_enabled: body['blind_index_enabled'] !== undefined ? asBoolFlag(body['blind_index_enabled'], existing.blind_index_enabled) : existing.blind_index_enabled,
      field_policy: fieldPolicyValue !== undefined ? (fieldPolicyValue ?? '{}') : existing.field_policy,
      shred_requested_at: existing.shred_requested_at,
      shred_completed_at: existing.shred_completed_at,
    });
    getKmsResolver()?.invalidate(tenantId);

    let bootstrapped = false;
    let bootstrapReason: string | undefined;
    const km = getEncryptionManager();
    // Auto-bootstrap on disabled→enabled transition.
    if (!wasEnabled && nextEnabled === 1 && km) {
      try {
        await km.bootstrapTenant({ tenantId, enable: true, ...(auth.userId ? { actor: auth.userId } : {}) });
        bootstrapped = true;
      } catch (err) {
        bootstrapReason = `bootstrap_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!wasEnabled && nextEnabled === 1 && !km) {
      bootstrapReason = 'manager_unavailable: WEAVE_ENCRYPTION_MASTER_KEY not configured';
    }

    const policy = await db.getTenantEncryptionPolicy(tenantId);
    json(res, 200, { policy, bootstrapped, ...(bootstrapReason ? { bootstrap_reason: bootstrapReason } : {}) });
  }, { auth: true, csrf: true });

  delMethod('/api/admin/tenant-encryption-policies/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const existing = await db.getTenantEncryptionPolicy(tenantId);
    if (!existing) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    // Refuse to delete a policy that still has live (non-revoked) key material.
    const [keks, deks, biks] = await Promise.all([store.listKeks(tenantId), store.listDeks(tenantId), store.listBiks(tenantId)]);
    const hasLive = [...keks, ...deks, ...biks].some((k) => k.status !== 'revoked');
    if (hasLive) {
      json(res, 409, { error: 'Cannot delete: tenant has live key material. POST /shred first.' }); return;
    }
    await db.deleteTenantEncryptionPolicy(tenantId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Lifecycle actions ─────────────────────────────────────

  router.post('/api/admin/tenant-encryption-policies/:tenantId/bootstrap', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable: WEAVE_ENCRYPTION_MASTER_KEY not set' }); return; }
    const tenantId = params['tenantId']!;
    const existing = await db.getTenantEncryptionPolicy(tenantId);
    if (!existing) { json(res, 404, { error: 'Tenant encryption policy not found (POST / first)' }); return; }
    try {
      const policy = await km.bootstrapTenant({ tenantId, enable: true, ...(auth.userId ? { actor: auth.userId } : {}) });
      json(res, 200, { ok: true, policy });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/rotate-dek', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    try {
      const dek = await km.rotateDek(tenantId, (auth.userId) ?? null);
      json(res, 200, { ok: true, dek: sanitize(dek) });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/rotate-kek', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    try {
      const kek = await km.rotateKek(tenantId, (auth.userId) ?? null);
      json(res, 200, { ok: true, kek: sanitize(kek) });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  // Phase 8: rotate the BIK (blind-index key). Marks the prior BIK 'previous'
  // so existing bidx values still reverse-match for read queries that fall back
  // to the previous-epoch MAC. Operators MUST follow up with /rebuild-bidx
  // before the previous BIK is revoked, otherwise login lookups will miss.
  router.post('/api/admin/tenant-encryption-policies/:tenantId/rotate-bik', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    try {
      const bik = await km.rotateBik(tenantId, (auth.userId) ?? null);
      json(res, 200, { ok: true, bik: sanitize(bik) });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  // Phase 8: rebuild every blind-index column for a tenant under the active BIK.
  // Currently rebuilds users.email_bidx (for the SYSTEM tenant scope). Returns
  // counts so operators can verify completeness. Idempotent — safe to re-run.
  router.post('/api/admin/tenant-encryption-policies/:tenantId/rebuild-bidx', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    const policy = await db.getTenantEncryptionPolicy(tenantId);
    if (!policy) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    if (policy.blind_index_enabled !== 1) {
      json(res, 400, { error: 'blind_index_enabled is false for this tenant' }); return;
    }
    const PAGE = 500;
    let cursor: string | null = null;
    let scanned = 0, written = 0, skipped = 0;
    try {
      // Loop pages — id-asc cursor avoids OFFSET drift.
      // Only the SYSTEM tenant is responsible for users.email_bidx today; for
      // any other tenantId we emit an empty result rather than silently
      // touching another tenant's user rows.
      const isSystem = tenantId === '__system__';
      while (isSystem) {
        const rows = await db.listUsersForBidxRebuild(PAGE, cursor);
        if (rows.length === 0) break;
        for (const r of rows) {
          scanned++;
          if (!r.email) { skipped++; continue; }
          try {
            const mac = await km.computeBlindIndex({
              tenantId, table: 'users', column: 'email', value: r.email,
            });
            await db.setUserEmailBidx(r.id, mac);
            written++;
          } catch {
            skipped++;
          }
        }
        cursor = rows[rows.length - 1]!.id;
        if (rows.length < PAGE) break;
      }
      json(res, 200, { ok: true, tenantId, scanned, written, skipped, scope: isSystem ? 'users.email' : 'noop' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err), scanned, written, skipped });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/shred', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (body['confirm'] !== tenantId) {
      json(res, 400, { error: `Shred requires body { "confirm": "${tenantId}" } to prevent accidents` }); return;
    }
    try {
      await km.shred(tenantId, (auth.userId) ?? null);
      json(res, 200, { ok: true, shredded: true });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  // ── Read-only inspection ──────────────────────────────────

  router.get('/api/admin/tenant-encryption-policies/:tenantId/keys', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    const [keks, deks, biks] = await Promise.all([store.listKeks(tenantId), store.listDeks(tenantId), store.listBiks(tenantId)]);
    json(res, 200, { keks: keks.map(sanitize), deks: deks.map(sanitize), biks: biks.map(sanitize) });
  }, { auth: true });

  router.get('/api/admin/tenant-encryption-policies/:tenantId/audit', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const url = new URL(req.url ?? '', 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const events = await db.listEncryptionAudit(tenantId, { limit, offset });
    json(res, 200, { events, limit, offset });
  }, { auth: true });

  // ── Phase 6: GDPR hard-shred + tenant deletion lifecycle ──

  router.post('/api/admin/tenant-encryption-policies/:tenantId/request-deletion', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const retentionDaysRaw = body['retentionDays'];
    const retentionDays = typeof retentionDaysRaw === 'number' && retentionDaysRaw > 0 ? retentionDaysRaw : 30;
    const reason = typeof body['reason'] === 'string' ? body['reason'] as string : null;
    const now = Date.now();
    const id = randomUUID();
    const requestedBy = (auth.userId) ?? null;
    try {
      await db.createTenantDeletionRequest({
        id,
        tenant_id: tenantId,
        requested_at: now,
        retention_until: now + retentionDays * 86400000,
        requested_by: requestedBy,
        status: 'pending',
        reason,
      });
      await db.insertEncryptionAudit({
        id: randomUUID(),
        tenant_id: tenantId,
        event_kind: 'tenant_deletion_requested',
        actor: requestedBy,
        details: JSON.stringify({ requestId: id, retentionDays, reason }),
        created_at: now,
      });
      const row = await db.getTenantDeletionRequest(id);
      json(res, 201, { request: row });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/cancel-deletion', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId']!;
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const requestId = typeof body['requestId'] === 'string' ? body['requestId'] as string : null;
    if (!requestId) { json(res, 400, { error: 'Body must include requestId' }); return; }
    const existing = await db.getTenantDeletionRequest(requestId);
    if (!existing || existing.tenant_id !== tenantId) { json(res, 404, { error: 'Deletion request not found' }); return; }
    if (existing.status !== 'pending') { json(res, 409, { error: `Cannot cancel: status is ${existing.status}` }); return; }
    const now = Date.now();
    const ok = await db.cancelTenantDeletionRequest(requestId, now);
    if (!ok) { json(res, 409, { error: 'Cancel failed (status changed)' }); return; }
    await db.insertEncryptionAudit({
      id: randomUUID(),
      tenant_id: tenantId,
      event_kind: 'tenant_deletion_cancelled',
      actor: (auth.userId) ?? null,
      details: JSON.stringify({ requestId }),
      created_at: now,
    });
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.post('/api/admin/tenant-encryption-policies/:tenantId/restore', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const km = getEncryptionManager();
    if (!km) { json(res, 503, { error: 'Encryption manager unavailable' }); return; }
    const tenantId = params['tenantId']!;
    if (!(await db.getTenantEncryptionPolicy(tenantId))) { json(res, 404, { error: 'Tenant encryption policy not found' }); return; }
    try {
      const result = await km.restoreFromShred(tenantId, (auth.userId) ?? null);
      json(res, 200, { ok: true, restored: result });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.get('/api/admin/tenant-deletion-requests', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const tenantId = url.searchParams.get('tenantId') ?? undefined;
    const statusRaw = url.searchParams.get('status') ?? undefined;
    const status = statusRaw === 'pending' || statusRaw === 'cancelled' || statusRaw === 'purged' ? statusRaw : undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const requests = await db.listTenantDeletionRequests({
      ...(tenantId ? { tenantId } : {}),
      ...(status ? { status } : {}),
      limit,
      offset,
    });
    json(res, 200, { requests, limit, offset });
  }, { auth: true });
}
