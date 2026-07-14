// SPDX-License-Identifier: MIT
/**
 * Admin routes for the Upgrade Engine's `check` command.
 *
 *   • POST /api/admin/upgrade/check     — poll the release source, verify the manifest, record the outcome,
 *                                         and return it (update_available / up_to_date / rejected+reason / none).
 *   • GET  /api/admin/upgrade/status    — the most recent check.
 *   • POST /api/admin/upgrade/preflight — read-only gates on the latest accepted release (safe-to-apply?).
 *   • POST /api/admin/upgrade/preview   — read-only four-layer plan of what applying it would do (JSON).
 *   • POST /api/admin/upgrade/apply     — apply the latest accepted release (L1→L4, snapshot + verify + rollback).
 *   • POST /api/admin/upgrade/rollback  — manually roll a run back to its retained pre-upgrade snapshot.
 *   • POST /api/admin/upgrade/code/baseline   — capture the source tree as the L2 code baseline.
 *   • GET  /api/admin/upgrade/code/status     — which vendor source files the operator has edited (read-only).
 *   • POST /api/admin/upgrade/code/scan       — scan the code tree + record changes as L2 review items.
 *   • GET  /api/admin/upgrade/attention       — drifted + version-lagging records in a family.
 *   • GET  /api/admin/upgrade/review          — the review queue (unresolved items, P1→P5 + tallies).
 *   • POST /api/admin/upgrade/review/:id/resolve — keep / adopt / defer one item.
 *   • POST /api/admin/upgrade/review/bulk     — bulk resolve (never P1).
 *   • POST /api/admin/upgrade/review/:id/undo    — re-open a resolved item (restore an adopt).
 *
 * Platform-admin only: discovering + trusting a release is a privileged, instance-wide operation. The route
 * is a thin shell over `checkForUpdate` (via the adapter, which supplies the SQL client) — it just assembles
 * the source/verifier/edition/version from environment config and reports the result. When update checks
 * aren't configured (no repo / no trusted keys) it returns `not_configured` rather than erroring.
 */
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import type { AuthContext } from '../../auth.js';

const isPlatformAdmin = (auth: AuthContext): boolean => auth.persona === 'platform_admin';

/**
 * Register the upgrade `check`/`status` routes.
 * @param router the app router.
 * @param db the database adapter (supplies `runUpgradeCheck` / `latestUpgradeReleaseCheck`).
 * @param helpers admin helpers (`json`).
 */
export function registerUpgradeRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;

  const requirePlatformAdmin = (res: Parameters<typeof json>[0], auth: AuthContext | null): auth is AuthContext => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return false; }
    if (!isPlatformAdmin(auth)) { json(res, 403, { error: 'Platform admin required' }); return false; }
    return true;
  };

  // Discover + verify + record the latest release.
  router.post('/api/admin/upgrade/check', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const { buildCheckConfigFromEnv, buildUpgradeTokenProvider, getAppVersion } = await import('../../upgrade-check.js');
    const config = buildCheckConfigFromEnv(getAppVersion(), buildUpgradeTokenProvider());
    if (!config) {
      json(res, 200, { status: 'not_configured', message: 'Set GENEWEAVE_UPGRADE_REPO and GENEWEAVE_UPGRADE_TRUSTED_KEYS to enable update checks.' });
      return;
    }
    if (typeof db.runUpgradeCheck !== 'function') { json(res, 501, { error: 'update checks not supported by this adapter' }); return; }
    try {
      json(res, 200, await db.runUpgradeCheck(config));
    } catch (err) {
      // The check itself surfaces policy failures as `rejected` outcomes; a throw here is a transport or
      // malformed-manifest error. Never echo request internals (or a token) back.
      json(res, 502, { error: 'release check failed', detail: (err as Error).message });
    }
  });

  // The most recent check (status view).
  router.get('/api/admin/upgrade/status', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const latest = typeof db.latestUpgradeReleaseCheck === 'function' ? await db.latestUpgradeReleaseCheck() : null;
    json(res, 200, { latest });
  });

  // Read-only preflight gates on the latest ACCEPTED release — is it safe to apply right now?
  router.post('/api/admin/upgrade/preflight', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runUpgradePreflight !== 'function') { json(res, 501, { error: 'preflight not supported by this adapter' }); return; }
    try {
      const result = await db.runUpgradePreflight();
      // `no_release` (nothing accepted to gate) is a normal 200 outcome, not an error.
      json(res, 200, 'status' in result ? { status: 'no_release', message: 'No accepted release to preflight; run the check first.' } : result);
    } catch (err) {
      json(res, 502, { error: 'preflight failed', detail: (err as Error).message });
    }
  });

  // Read-only four-layer preview of the latest ACCEPTED release — what applying it would do (nothing applied).
  router.post('/api/admin/upgrade/preview', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runUpgradePreview !== 'function') { json(res, 501, { error: 'preview not supported by this adapter' }); return; }
    try {
      const result = await db.runUpgradePreview();
      json(res, 200, 'status' in result ? { status: 'no_release', message: 'No accepted release to preview; run the check first.' } : result);
    } catch (err) {
      json(res, 502, { error: 'preview failed', detail: (err as Error).message });
    }
  });

  // APPLY the latest ACCEPTED release (L1→L4, snapshot + rollback). Mutating + privileged.
  router.post('/api/admin/upgrade/apply', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runUpgradeApply !== 'function') { json(res, 501, { error: 'apply not supported by this adapter' }); return; }
    // Optional { force?, unresolvedCodePaths? } body; a malformed body is treated as no options, never a crash.
    let opts: { force?: boolean; unresolvedCodePaths?: string[] } = {};
    try {
      const raw = await readBody(req);
      if (raw) {
        const b = JSON.parse(raw) as { force?: unknown; unresolvedCodePaths?: unknown };
        opts = {
          force: b.force === true,
          unresolvedCodePaths: Array.isArray(b.unresolvedCodePaths) ? b.unresolvedCodePaths.filter((p): p is string => typeof p === 'string') : [],
        };
      }
    } catch { /* malformed body → default options */ }
    try {
      const result = await db.runUpgradeApply(opts);
      // A blocked apply (preflight_failed / busy / no_release) is a normal 200 outcome the operator acts on.
      json(res, 200, 'status' in result && result.status === 'no_release' ? { status: 'no_release', message: 'No accepted release to apply; run the check first.' } : result);
    } catch (err) {
      json(res, 502, { error: 'apply failed', detail: (err as Error).message });
    }
  });

  // ── Review queue ──────────────────────────────────────────────────────────────────────────────────────
  const REVIEW_ACTIONS = new Set(['keep', 'adopt', 'defer']);

  // ── L2 code layer ─────────────────────────────────────────────────────────────────────────────────────
  // Capture the current source tree as the stored code baseline (the BASE for future scans).
  router.post('/api/admin/upgrade/code/baseline', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.captureCodeBaseline !== 'function') { json(res, 501, { error: 'code baseline not supported by this adapter' }); return; }
    try { json(res, 200, await db.captureCodeBaseline()); }
    catch (err) { json(res, 502, { error: 'baseline capture failed', detail: (err as Error).message }); }
  });

  // Read-only `code status` — which vendor source files the operator has modified since the baseline.
  router.get('/api/admin/upgrade/code/status', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runCodeStatus !== 'function') { json(res, 501, { error: 'code status not supported by this adapter' }); return; }
    try { json(res, 200, await db.runCodeStatus()); }
    catch (err) { json(res, 502, { error: 'code status failed', detail: (err as Error).message }); }
  });

  // Scan the code tree and record its changes as L2 review items (they join the review queue).
  router.post('/api/admin/upgrade/code/scan', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runCodeScan !== 'function') { json(res, 501, { error: 'code scan not supported by this adapter' }); return; }
    try { json(res, 200, await db.runCodeScan()); }
    catch (err) { json(res, 502, { error: 'code scan failed', detail: (err as Error).message }); }
  });

  // The "needs attention" report for a family — drifted + version-lagging records. ?family= (required), ?tenantId=.
  router.get('/api/admin/upgrade/attention', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.upgradeAttention !== 'function') { json(res, 501, { error: 'attention report not supported by this adapter' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const family = url.searchParams.get('family');
    if (!family) { json(res, 400, { error: 'family is required' }); return; }
    const tenantId = url.searchParams.get('tenantId');
    try {
      json(res, 200, await db.upgradeAttention(family, tenantId ?? undefined));
    } catch (err) {
      json(res, 502, { error: 'attention report failed', detail: (err as Error).message });
    }
  });

  // The review queue — unresolved items with tallies. Optional ?family= / ?priority= narrowing.
  router.get('/api/admin/upgrade/review', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.upgradeReviewQueue !== 'function') { json(res, 501, { error: 'review queue not supported by this adapter' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const filter: { family?: string; priority?: string } = {};
    const fam = url.searchParams.get('family'); if (fam) filter.family = fam;
    const pri = url.searchParams.get('priority'); if (pri) filter.priority = pri;
    json(res, 200, await db.upgradeReviewQueue(filter));
  });

  // Resolve one item: { action: 'keep'|'adopt'|'defer', comment? }.
  router.post('/api/admin/upgrade/review/:id/resolve', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.resolveUpgradeReviewItem !== 'function') { json(res, 501, { error: 'review not supported by this adapter' }); return; }
    let body: { action?: unknown; comment?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* bad body */ }
    const action = String(body.action ?? '');
    if (!REVIEW_ACTIONS.has(action)) { json(res, 400, { error: "action must be 'keep', 'adopt', or 'defer'" }); return; }
    try {
      const result = await db.resolveUpgradeReviewItem(params['id']!, action as 'keep' | 'adopt' | 'defer', {
        resolvedBy: auth!.userId, ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
      });
      json(res, result.ok ? 200 : 409, result);
    } catch (err) {
      json(res, 502, { error: 'resolve failed', detail: (err as Error).message });
    }
  });

  // Bulk resolve: { action, family?, priority? }. P1 items are never bulk-resolved (server-enforced).
  router.post('/api/admin/upgrade/review/bulk', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.bulkResolveUpgradeReview !== 'function') { json(res, 501, { error: 'review not supported by this adapter' }); return; }
    let body: { action?: unknown; family?: unknown; priority?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* bad body */ }
    const action = String(body.action ?? '');
    if (!REVIEW_ACTIONS.has(action)) { json(res, 400, { error: "action must be 'keep', 'adopt', or 'defer'" }); return; }
    const filter: { family?: string; priority?: string } = {};
    if (typeof body.family === 'string') filter.family = body.family;
    if (typeof body.priority === 'string') filter.priority = body.priority;
    try {
      json(res, 200, await db.bulkResolveUpgradeReview(action as 'keep' | 'adopt' | 'defer', filter, { resolvedBy: auth!.userId }));
    } catch (err) {
      json(res, 502, { error: 'bulk resolve failed', detail: (err as Error).message });
    }
  });

  // TEST-ONLY: seed a mixed review queue for the Upgrade Center E2E. Registered only under PLAYWRIGHT_E2E so
  // it can never exist in production.
  if (process.env['PLAYWRIGHT_E2E'] === '1') {
    // Promote the current user to platform_admin so the E2E can drive the platform-admin-gated upgrade routes
    // (a self-registered user is only tenant_user/tenant_admin; auth reads persona fresh from the DB, so no
    // re-login is needed). Requires authentication but NOT platform_admin — that's what it grants.
    router.post('/api/admin/upgrade/_test/promote-admin', async (_req, res, _params, auth) => {
      if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
      if (typeof db.updateUserPersona !== 'function') { json(res, 501, { error: 'not supported by this adapter' }); return; }
      await db.updateUserPersona(auth.userId, 'platform_admin');
      json(res, 200, { ok: true, persona: 'platform_admin' });
    });
    router.post('/api/admin/upgrade/_test/seed-review', async (_req, res, _params, auth) => {
      if (!requirePlatformAdmin(res, auth)) return;
      if (typeof db.seedUpgradeReviewFixture !== 'function') { json(res, 501, { error: 'fixture not supported by this adapter' }); return; }
      json(res, 200, await db.seedUpgradeReviewFixture());
    });
  }

  // Undo (re-open) a resolved item; an adopt is reverted to its captured pre-adopt state.
  router.post('/api/admin/upgrade/review/:id/undo', async (_req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.undoUpgradeReviewItem !== 'function') { json(res, 501, { error: 'review not supported by this adapter' }); return; }
    try {
      const result = await db.undoUpgradeReviewItem(params['id']!);
      json(res, result.ok ? 200 : 409, result);
    } catch (err) {
      json(res, 502, { error: 'undo failed', detail: (err as Error).message });
    }
  });

  // Manually roll a run back to its retained pre-upgrade snapshot. Mutating + privileged.
  router.post('/api/admin/upgrade/rollback', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runUpgradeRollback !== 'function') { json(res, 501, { error: 'rollback not supported by this adapter' }); return; }
    let runId = '';
    try { const raw = await readBody(req); if (raw) runId = String((JSON.parse(raw) as { runId?: unknown }).runId ?? ''); } catch { /* bad body → empty runId */ }
    if (!runId) { json(res, 400, { error: 'runId is required' }); return; }
    try {
      json(res, 200, await db.runUpgradeRollback(runId));
    } catch (err) {
      json(res, 502, { error: 'rollback failed', detail: (err as Error).message });
    }
  });

  // ── Automation: resolution rules + per-family auto-adopt policy ──────────────────────────────────
  const POLICIES = new Set(['always', 'patch_only', 'never']);

  // Apply the active resolution rules across the queue (P1 never auto-resolved; serialized by the mutex).
  router.post('/api/admin/upgrade/rules/apply', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.applyUpgradeResolutionRules !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    let body: { family?: unknown; priority?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* bad body → apply to all */ }
    const opts: { resolvedBy?: string | null; family?: string; priority?: string } = { resolvedBy: auth!.userId };
    if (typeof body.family === 'string') opts.family = body.family;
    if (typeof body.priority === 'string') opts.priority = body.priority;
    try { json(res, 200, await db.applyUpgradeResolutionRules(opts)); }
    catch (err) { json(res, 502, { error: 'apply rules failed', detail: (err as Error).message }); }
  });

  // List resolution rules (?activeOnly=1 = the applied set).
  router.get('/api/admin/upgrade/rules', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.listUpgradeResolutionRules !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    const activeOnly = new URL(req.url ?? '', 'http://localhost').searchParams.get('activeOnly') === '1';
    json(res, 200, { rules: await db.listUpgradeResolutionRules({ activeOnly }) });
  });

  // Create a resolution rule: { key, name, action, seq?, matchFamilies?, matchPriorities?, matchDispositions?, tag?, enabled? }.
  router.post('/api/admin/upgrade/rules', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.createUpgradeResolutionRule !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    let body: Record<string, unknown> = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (typeof body['key'] !== 'string' || typeof body['name'] !== 'string' || typeof body['action'] !== 'string') { json(res, 400, { error: 'key, name, action are required' }); return; }
    try {
      const rule = await db.createUpgradeResolutionRule(body as unknown as import('../../upgrade-automation.js').ResolutionRuleInput, { createdBy: auth!.userId });
      json(res, 200, rule);
    } catch (err) { json(res, 400, { error: 'create rule failed', detail: (err as Error).message }); }
  });

  // Update a resolution rule.
  router.put('/api/admin/upgrade/rules/:id', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.updateUpgradeResolutionRule !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    let body: Record<string, unknown> = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    try {
      const rule = await db.updateUpgradeResolutionRule(params['id']!, body as Partial<import('../../upgrade-automation.js').ResolutionRuleInput>);
      json(res, rule ? 200 : 404, rule ?? { error: 'rule not found' });
    } catch (err) { json(res, 400, { error: 'update rule failed', detail: (err as Error).message }); }
  });

  // Delete a resolution rule.
  router.del('/api/admin/upgrade/rules/:id', async (_req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.deleteUpgradeResolutionRule !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    const ok = await db.deleteUpgradeResolutionRule(params['id']!);
    json(res, ok ? 200 : 404, { ok });
  });

  // List per-family auto-adopt policy overrides.
  router.get('/api/admin/upgrade/family-policy', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.listUpgradeFamilyPolicies !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    json(res, 200, { policies: await db.listUpgradeFamilyPolicies() });
  });

  // Set a family's auto-adopt policy: PUT /family-policy/:family { policy: 'always'|'patch_only'|'never', note? }.
  router.put('/api/admin/upgrade/family-policy/:family', async (req, res, params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.setUpgradeFamilyPolicy !== 'function') { json(res, 501, { error: 'automation not supported by this adapter' }); return; }
    let body: { policy?: unknown; note?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const policy = String(body.policy ?? '');
    if (!POLICIES.has(policy)) { json(res, 400, { error: "policy must be 'always', 'patch_only', or 'never'" }); return; }
    try {
      const row = await db.setUpgradeFamilyPolicy(params['family']!, policy as 'always' | 'patch_only' | 'never', {
        updatedBy: auth!.userId, ...(typeof body.note === 'string' ? { note: body.note } : {}),
      });
      json(res, 200, row);
    } catch (err) { json(res, 400, { error: 'set policy failed', detail: (err as Error).message }); }
  });

  // ── Propagation: signed resolution bundles ────────────────────────────────────────────────────────
  // Export the resolved decisions as a signed bundle (optional { runId }).
  router.post('/api/admin/upgrade/resolutions/export', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.exportUpgradeResolutionBundle !== 'function') { json(res, 501, { error: 'propagation not supported by this adapter' }); return; }
    let body: { runId?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* export all */ }
    try {
      const out = await db.exportUpgradeResolutionBundle(typeof body.runId === 'string' ? { runId: body.runId } : {});
      if ('status' in out) { json(res, 200, { status: 'not_configured', message: 'Set GENEWEAVE_UPGRADE_SIGNING_KEY to enable resolution-bundle export.' }); return; }
      json(res, 200, out);
    } catch (err) { json(res, 502, { error: 'export failed', detail: (err as Error).message }); }
  });

  // Verify + apply a signed resolution bundle (body = the bundle).
  router.post('/api/admin/upgrade/resolutions/import', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.importUpgradeResolutionBundle !== 'function') { json(res, 501, { error: 'propagation not supported by this adapter' }); return; }
    let bundle: import('../../upgrade-bundle.js').SignedResolutionBundle;
    try { bundle = JSON.parse((await readBody(req)) || '{}'); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!bundle || typeof bundle !== 'object' || !('signature' in bundle) || !Array.isArray((bundle as { entries?: unknown }).entries)) { json(res, 400, { error: 'not a signed resolution bundle' }); return; }
    try {
      const out = await db.importUpgradeResolutionBundle(bundle, { resolvedBy: auth!.userId });
      if ('status' in out) { json(res, 200, { status: 'not_configured', message: 'Set GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS to enable resolution-bundle import.' }); return; }
      // A rejected (bad/untrusted signature or edition mismatch) import is a 200 with the reason — it applied nothing.
      json(res, 200, out);
    } catch (err) { json(res, 502, { error: 'import failed', detail: (err as Error).message }); }
  });

  // ── Hardening: prune the realm_versions log (retention GC that respects pins) ─────────────────────
  // POST { keepPerKey?, family?, dryRun? } — keeps head-window + live-referenced + pinned versions.
  router.post('/api/admin/upgrade/prune-versions', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.pruneRealmVersions !== 'function') { json(res, 501, { error: 'pruning not supported by this adapter' }); return; }
    let body: { keepPerKey?: unknown; family?: unknown; dryRun?: unknown } = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* prune all with defaults */ }
    const opts: { keepPerKey?: number; family?: string; dryRun?: boolean } = {};
    if (typeof body.keepPerKey === 'number') opts.keepPerKey = body.keepPerKey;
    if (typeof body.family === 'string') opts.family = body.family;
    if (typeof body.dryRun === 'boolean') opts.dryRun = body.dryRun;
    try { json(res, 200, await db.pruneRealmVersions(opts)); }
    catch (err) { json(res, 400, { error: 'prune failed', detail: (err as Error).message }); }
  });

  // Read recent local upgrade telemetry (PII-free lifecycle events). ?event= / ?limit= optional.
  router.get('/api/admin/upgrade/telemetry', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.listUpgradeTelemetry !== 'function') { json(res, 501, { error: 'telemetry not supported by this adapter' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const opts: { event?: string; limit?: number } = {};
    const ev = url.searchParams.get('event'); if (ev) opts.event = ev;
    const lim = url.searchParams.get('limit'); if (lim && Number.isFinite(Number(lim))) opts.limit = Number(lim);
    json(res, 200, { events: await db.listUpgradeTelemetry(opts) });
  });
}
