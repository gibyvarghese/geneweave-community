/**
 * @weaveintel/geneweave — Admin Tenancy Realm governance routes (Section D).
 *
 * The realm's WRITE path. Resolution (who gets which copy) is elsewhere; these routes govern who may
 * change the shared defaults:
 *
 *   ProposeToRealm (D12)   POST   /api/admin/realm/proposals               a tenant proposes its fork
 *                          GET    /api/admin/realm/proposals               the review queue
 *                          POST   /api/admin/realm/proposals/:id/approve   platform admin → promotes
 *                          POST   /api/admin/realm/proposals/:id/reject    platform admin
 *   Deprecation (D15)      POST   /api/admin/realm/:family/:id/deprecate   platform admin
 *                          POST   /api/admin/realm/:family/:id/undeprecate platform admin
 *   Reparent (D16)         POST   /api/admin/tenants/:id/reparent          platform admin
 *
 * Authorization, deliberately two-tier: proposing is a TENANT-admin act (you may only propose a fork
 * your own tenant owns); approving/rejecting/deprecating/reparenting change the SHARED defaults or the
 * org tree, so they are PLATFORM-admin only. Before this, `POST /prompts/:id/promote` let any
 * authenticated admin overwrite the global default for every tenant — that hole is closed here too.
 */
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import type { AuthContext } from '../../auth.js';
import { isRealmFamily } from '../../realm-families.js';
import type { ProposalStatus } from '../../realm-governance.js';
import { getCapabilityMatrixCache } from '../../capability-matrix-cache.js';
import { emitCacheEvent } from '../../cache-invalidator.js';

const isPlatformAdmin = (auth: AuthContext): boolean => auth.persona === 'platform_admin';

export function registerRealmGovernanceRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  /** 401 unless authenticated; 403 unless platform admin. Returns true when the caller may proceed. */
  const requirePlatformAdmin = (res: Parameters<typeof json>[0], auth: AuthContext | null): auth is AuthContext => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return false; }
    if (!isPlatformAdmin(auth)) { json(res, 403, { error: 'Platform admin required' }); return false; }
    return true;
  };

  /** A REQUIRED body: malformed JSON is a 400 and the caller must bail. */
  const parseBody = async (req: Parameters<typeof readBody>[0], res: Parameters<typeof json>[0]): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse(await readBody(req)) as Record<string, unknown>; }
    catch { json(res, 400, { error: 'Invalid JSON' }); return null; }
  };

  /** An OPTIONAL body (review notes etc.): an empty or unparsable body is simply `{}`, never a 400. */
  const optionalBody = async (req: Parameters<typeof readBody>[0]): Promise<Record<string, unknown>> => {
    try {
      const raw = (await readBody(req)).trim();
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };

  // ── D12: propose ────────────────────────────────────────────────────────────
  // A tenant admin proposes that their fork become the global default. Nothing changes yet.
  router.post('/api/admin/realm/proposals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const body = await parseBody(req, res);
    if (!body) return;
    const family = String(body['family'] ?? '');
    const forkId = String(body['forkId'] ?? '');
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    if (!forkId) { json(res, 400, { error: 'forkId required' }); return; }

    const result = await db.proposeRealmFork(family, forkId, {
      proposedBy: auth.userId,
      note: body['note'] == null ? null : String(body['note']),
    });
    if (!result.ok) { json(res, result.reason === 'not found' ? 404 : 400, { error: result.reason }); return; }

    // A tenant admin may only propose a fork their OWN tenant owns; a platform admin may propose any.
    if (!isPlatformAdmin(auth) && result.proposal && auth.tenantId !== result.proposal.tenant_id) {
      json(res, 403, { error: 'you may only propose a fork owned by your own tenant' });
      return;
    }
    json(res, 201, { proposal: result.proposal });
  }, { auth: true, csrf: true });

  // ── D12: the review queue ───────────────────────────────────────────────────
  // Platform admins see every tenant's proposals; a tenant admin sees only its own.
  router.get('/api/admin/realm/proposals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const status = url.searchParams.get('status');
    const family = url.searchParams.get('family');
    if (status && !['pending', 'approved', 'rejected'].includes(status)) { json(res, 400, { error: 'bad status' }); return; }
    if (family && !isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }

    const all = await db.listRealmProposals({
      status: (status as ProposalStatus | null) ?? 'pending',
      ...(family ? { family } : {}),
    });
    const proposals = isPlatformAdmin(auth) ? all : all.filter((p) => p.tenant_id === auth.tenantId);
    json(res, 200, { proposals });
  }, { auth: true });

  // ── D12: approve (promotes the fork into the global default) ────────────────
  router.post('/api/admin/realm/proposals/:id/approve', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const body = await optionalBody(req);
    const result = await db.approveRealmProposal(params['id']!, {
      reviewer: auth.userId,
      reviewNote: body['reviewNote'] == null ? null : String(body['reviewNote']),
    });
    if (!result.ok) { json(res, result.reason === 'proposal not found' ? 404 : 400, { error: result.reason }); return; }
    await emitCacheEvent('prompt_update', { promoted: result.promoted?.globalId });
    json(res, 200, { ok: true, promoted: result.promoted });
  }, { auth: true, csrf: true });

  // ── D12: reject (changes nothing) ───────────────────────────────────────────
  router.post('/api/admin/realm/proposals/:id/reject', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const body = await optionalBody(req);
    const result = await db.rejectRealmProposal(params['id']!, {
      reviewer: auth.userId,
      reviewNote: body['reviewNote'] == null ? null : String(body['reviewNote']),
    });
    if (!result.ok) { json(res, result.reason === 'proposal not found' ? 404 : 400, { error: result.reason }); return; }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── D15: deprecate / undeprecate a global default ───────────────────────────
  // Deprecating never breaks a tenant already using the default — it only blocks NEW customizations.
  router.post('/api/admin/realm/:family/:id/deprecate', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const family = params['family']!;
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    const body = await optionalBody(req);
    const result = await db.deprecateRealmRecord(family, params['id']!, {
      note: body['note'] == null ? null : String(body['note']),
      supersededById: body['supersededById'] == null ? null : String(body['supersededById']),
    });
    if (!result.ok) { json(res, result.reason === 'not found' ? 404 : 400, { error: result.reason }); return; }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.post('/api/admin/realm/:family/:id/undeprecate', async (_req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const family = params['family']!;
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    const result = await db.undeprecateRealmRecord(family, params['id']!);
    if (!result.ok) { json(res, result.reason === 'not found' ? 404 : 400, { error: result.reason }); return; }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── D16: reparent a tenant in the org tree ──────────────────────────────────
  // Moving a tenant changes its LINEAGE, which changes every inherited config the moved subtree
  // resolves. The capability matrix is the one realm read-path held in a process cache keyed by
  // tenant, so it must be flushed; the other families resolve straight from the DB and self-heal.
  router.post('/api/admin/tenants/:id/reparent', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const body = await parseBody(req, res);
    if (!body) return;
    if (!Object.hasOwn(body, 'newParentTenantId')) { json(res, 400, { error: 'newParentTenantId required (null to make it a root)' }); return; }
    const newParent = body['newParentTenantId'] == null ? null : String(body['newParentTenantId']);

    const diff = await db.reparentTenant(params['id']!, newParent);
    if (!diff.ok) { json(res, diff.reason === 'tenant not found' ? 404 : 400, { error: diff.reason }); return; }

    getCapabilityMatrixCache().invalidateCapabilityScores();
    await emitCacheEvent('prompt_update', { reparented: diff.tenantId });
    json(res, 200, diff); // { ok, tenantId, from, to, affectedTenantIds }
  }, { auth: true, csrf: true });
}
