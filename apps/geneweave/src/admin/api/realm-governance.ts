/**
 * @weaveintel/geneweave — Admin Tenancy Realm governance + drift routes.
 *
 * The realm's WRITE path. Resolution (who gets which copy) is elsewhere; these routes govern who may
 * change the shared defaults, and how a drifted record gets reconciled:
 *
 *   ProposeToRealm         POST   /api/admin/realm/proposals               a tenant proposes its fork
 *                          GET    /api/admin/realm/proposals               the review queue
 *                          POST   /api/admin/realm/proposals/:id/approve   platform admin → promotes
 *                          POST   /api/admin/realm/proposals/:id/reject    platform admin
 *   Deprecation            POST   /api/admin/realm/:family/:id/deprecate   platform admin
 *                          POST   /api/admin/realm/:family/:id/undeprecate platform admin
 *   Reparent               POST   /api/admin/tenants/:id/reparent          platform admin
 *   Guardrail posture      POST   /api/admin/realm/guardrails/profile/lean platform admin
 *                          DEL    /api/admin/realm/guardrails/profile/lean platform admin (revert)
 *   Drift workbench        GET    /api/admin/realm/:family/drift           what has drifted, and how
 *                          GET    /api/admin/realm/:family/:id/diff        BASE / LOCAL / REMOTE
 *                          POST   /api/admin/realm/:family/:id/merge       apply a resolved merge
 *
 * Authorization, deliberately two-tier: proposing is a TENANT-admin act (you may only propose a fork
 * your own tenant owns), and a tenant may diff/merge its OWN forks. Approving, rejecting, deprecating,
 * reparenting, thinning guardrails, or merging a GLOBAL default all change what every tenant resolves,
 * so they are PLATFORM-admin only. Before this, `POST /prompts/:id/promote` let any authenticated admin
 * overwrite the global default for every tenant — that hole is closed here too.
 */
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import type { AuthContext } from '../../auth.js';
import { isRealmFamily } from '../../realm-families.js';
import type { ProposalStatus } from '../../realm-governance.js';
import { getCapabilityMatrixCache } from '../../capability-matrix-cache.js';
import { emitCacheEvent } from '../../cache-invalidator.js';
import { applyLeanGuardrailProfile, clearGuardrailProfile } from '../../realm-guardrail-profile.js';

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

  // ── E20: the lean guardrail profile (posture as a per-tenant overlay) ───────
  // Turn the model-graded guardrails off for one tenant — cheaper, faster — while every safety control
  // (redaction, content filters, injection regexes, budgets, escalation) stays on and is reported back.
  // Platform-admin only: a tenant must not be able to thin its own guardrails unilaterally.
  router.post('/api/admin/realm/guardrails/profile/lean', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const tenantId = new URL(req.url ?? '/', 'http://x').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    json(res, 200, { ok: true, ...(await applyLeanGuardrailProfile(db, tenantId)) });
  }, { auth: true, csrf: true });

  // Revert to the shared posture: drop this tenant's guardrail overlays entirely.
  router.del('/api/admin/realm/guardrails/profile/lean', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const tenantId = new URL(req.url ?? '/', 'http://x').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    json(res, 200, { ok: true, ...(await clearGuardrailProfile(db, tenantId)) });
  }, { auth: true, csrf: true });

  // ── E18: the drift diff / merge workbench ───────────────────────────────────
  // Which records in this family have drifted, and how. `?tenantId=` narrows to one tenant's forks.
  router.get('/api/admin/realm/:family/drift', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const family = params['family']!;
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('tenantId');
    // A platform admin sees the whole family by default, or one tenant when ?tenantId= is given.
    // Anyone else is scoped to their own tenant's forks, whatever they asked for.
    const opts = isPlatformAdmin(auth)
      ? (q === null ? {} : { tenantId: q })
      : { tenantId: auth.tenantId ?? null };
    json(res, 200, await db.realmDriftReport(family, opts));
  }, { auth: true });

  // The three-way diff for one record: BASE (what it was forked from) / LOCAL / REMOTE, field by field.
  router.get('/api/admin/realm/:family/:id/diff', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const family = params['family']!;
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    const diff = await db.realmDiff(family, params['id']!);
    if ('error' in diff) { json(res, diff.error === 'not found' ? 404 : 400, { error: diff.error }); return; }
    if (!(await mayEditRecord(family, params['id']!, auth))) { json(res, 403, { error: 'Not your record' }); return; }
    json(res, 200, diff);
  }, { auth: true });

  // Apply a resolved merge. Merging a GLOBAL default changes what every tenant sees → platform admin.
  // Merging a tenant's own fork is that tenant's business. A conflict left unresolved is a 409, never a
  // silent pick — refusing to guess is the whole point of a merge tool.
  router.post('/api/admin/realm/:family/:id/merge', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const family = params['family']!;
    if (!isRealmFamily(family)) { json(res, 400, { error: `unknown realm family '${family}'` }); return; }
    if (!(await mayEditRecord(family, params['id']!, auth))) { json(res, 403, { error: 'Not your record' }); return; }
    const body = await optionalBody(req);
    const resolved = (body['resolved'] && typeof body['resolved'] === 'object') ? body['resolved'] as Record<string, unknown> : {};

    const result = await db.realmMerge(family, params['id']!, resolved);
    if (!result.ok) {
      const status = result.reason === 'not found' ? 404 : result.reason?.startsWith('unresolved conflicts') ? 409 : 400;
      json(res, status, { error: result.reason }); return;
    }
    await emitCacheEvent('prompt_update', { merged: params['id'] });
    json(res, 200, result);
  }, { auth: true, csrf: true });

  /**
   * A platform admin may touch any record. Anyone else may only touch their own tenant's fork — never a
   * global default (that would change what every tenant resolves).
   */
  async function mayEditRecord(family: string, recordId: string, auth: AuthContext): Promise<boolean> {
    if (isPlatformAdmin(auth)) return true;
    const report = await db.realmDriftReport(family, { tenantId: auth.tenantId ?? null });
    return report.entries.some((e) => e.id === recordId);
  }

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
