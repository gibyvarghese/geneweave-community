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
  //
  // Source precedence: the operator-managed DB config (upgrade_source_config, set from the UI) wins; the
  // GENEWEAVE_UPGRADE_* env vars are the fallback for headless/bootstrap deploys. Either way the SAME signed-
  // manifest trust pipeline runs (Ed25519 → edition → freshness → anti-rollback).
  router.post('/api/admin/upgrade/check', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    const { buildCheckConfigFromEnv, buildUpgradeTokenProvider, getAppVersion } = await import('../../upgrade-check.js');
    const installedVersion = getAppVersion();
    const tokenProvider = buildUpgradeTokenProvider(); // env-backed; DB-vault token wiring lands in Phase 3
    let config = null as import('../../upgrade-check.js').CheckConfig | null;
    if (typeof db.getUpgradeSourceConfig === 'function') {
      const stored = await db.getUpgradeSourceConfig();
      if (stored) {
        const { buildCheckConfigFromSource } = await import('../../upgrade-source.js');
        config = buildCheckConfigFromSource(stored, installedVersion, tokenProvider);
      }
    }
    if (!config) config = buildCheckConfigFromEnv(installedVersion, tokenProvider); // env fallback
    if (!config) {
      json(res, 200, { status: 'not_configured', message: 'Configure a release source (repo + trusted keys) in the Upgrade Center, or set GENEWEAVE_UPGRADE_REPO / GENEWEAVE_UPGRADE_TRUSTED_KEYS.' });
      return;
    }
    if (typeof db.runUpgradeCheck !== 'function') { json(res, 501, { error: 'update checks not supported by this adapter' }); return; }
    try {
      const result = await db.runUpgradeCheck(config);
      // Echo the deployed version so the UI can render "deployed vX · available vY" without a second call.
      json(res, 200, { ...result, installedVersion });
    } catch (err) {
      // The check itself surfaces policy failures as `rejected` outcomes; a throw here is a transport or
      // malformed-manifest error. Never echo request internals (or a token) back.
      json(res, 502, { error: 'release check failed', detail: (err as Error).message });
    }
  });

  // ── Source configuration (where this instance discovers releases) ─────────────────────────────────────
  // Read the operator-configured release source. Trusted keys are PUBLIC (safe to return); no secret token
  // is ever stored or returned — only a `tokenCredentialId` reference. Returns { source: null } when unset.
  router.get('/api/admin/upgrade/source', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.getUpgradeSourceConfig !== 'function') { json(res, 501, { error: 'source config not supported by this adapter' }); return; }
    json(res, 200, { source: await db.getUpgradeSourceConfig() });
  });

  // Set the release source: PUT /source { repo, edition?, assetName?, trustedKeysPem, apiBase?, tokenCredentialId?, enabled? }.
  router.put('/api/admin/upgrade/source', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.setUpgradeSourceConfig !== 'function') { json(res, 501, { error: 'source config not supported by this adapter' }); return; }
    let body: Record<string, unknown> = {};
    try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const { validateSourceConfig } = await import('../../upgrade-source.js');
    const input = {
      repo: String(body['repo'] ?? ''),
      edition: String(body['edition'] ?? 'community'),
      assetName: String(body['assetName'] ?? 'manifest.json'),
      trustedKeysPem: String(body['trustedKeysPem'] ?? ''),
      apiBase: body['apiBase'] == null ? null : String(body['apiBase']),
      tokenCredentialId: body['tokenCredentialId'] == null ? null : String(body['tokenCredentialId']),
      enabled: body['enabled'] === undefined ? true : Boolean(body['enabled']),
    };
    const errors = validateSourceConfig(input);
    if (errors.length > 0) { json(res, 400, { error: 'invalid source config', errors }); return; }
    try {
      json(res, 200, { source: await db.setUpgradeSourceConfig(input, { updatedBy: auth!.userId }) });
    } catch (err) { json(res, 400, { error: 'save source failed', detail: (err as Error).message }); }
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

  // One-click upgrade: preflight → derive the code-conflict gate from the recorded conflicts (so the operator
  // needn't pass unresolvedCodePaths by hand) → apply → an honest, plain-language outcome. Preflight failures
  // are returned as `blocked` (with the failing gates) instead of applying — pass { force:true } to override.
  router.post('/api/admin/upgrade/run', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.runUpgradeApply !== 'function') { json(res, 501, { error: 'apply not supported by this adapter' }); return; }
    let force = false;
    try { const raw = await readBody(req); if (raw) force = (JSON.parse(raw) as { force?: unknown }).force === true; } catch { /* default */ }
    const { computeBumpType, describeUpgradeOutcome } = await import('../../upgrade-orchestrate.js');
    const { resolveEditionL2Mode } = await import('../../upgrade-apply.js');
    try {
      // Preflight gate (unless forced) — never mutate when a hard check fails.
      if (!force && typeof db.runUpgradePreflight === 'function') {
        const pf = await db.runUpgradePreflight();
        if (pf && 'ok' in pf && pf.ok === false) { json(res, 200, { status: 'blocked', preflight: pf }); return; }
      }
      // Auto-derive the code-conflict gate: any unresolved code conflict defers the schema/data that depends on it.
      const conflicts = typeof db.listCodeConflicts === 'function' ? await db.listCodeConflicts() : [];
      const unresolvedCodePaths = conflicts.map((c) => c.path);
      // Version + edition for the summary: ApplyResult carries neither — from = installed, to = accepted release.
      const { getAppVersion } = await import('../../upgrade-check.js');
      const target = typeof db.getAcceptedReleaseInfo === 'function' ? await db.getAcceptedReleaseInfo() : null;
      const result = await db.runUpgradeApply({ force, unresolvedCodePaths });
      if ('status' in result && result.status === 'no_release') { json(res, 200, { status: 'no_release', message: 'No accepted release to apply; run the check first.' }); return; }
      const applied = result as import('../../upgrade-apply.js').ApplyResult;
      const fromVersion = getAppVersion();
      const toVersion = target?.version ?? '';
      const bumpType = computeBumpType(fromVersion, toVersion);
      const edition = target?.edition ?? process.env['GENEWEAVE_EDITION'] ?? 'community';
      const outcome = describeUpgradeOutcome(applied, { bumpType, toVersion, l2mode: resolveEditionL2Mode(edition), codeConflicts: conflicts.length });
      json(res, 200, { status: 'ran', bumpType, fromVersion, toVersion, outcome, apply: applied, codeConflicts: conflicts.length });
    } catch (err) {
      json(res, 502, { error: 'upgrade run failed', detail: (err as Error).message });
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
    router.post('/api/admin/upgrade/_test/seed-code-conflict', async (_req, res, _params, auth) => {
      if (!requirePlatformAdmin(res, auth)) return;
      if (typeof db.seedCodeConflictFixture !== 'function') { json(res, 501, { error: 'fixture not supported by this adapter' }); return; }
      json(res, 200, await db.seedCodeConflictFixture());
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

  // ── L2 in-app code-conflict merge (the @codemirror/merge view's backend) ──────────────────────────
  // The unresolved code conflicts (family='code') awaiting a merge decision.
  router.get('/api/admin/upgrade/code/conflicts', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.listCodeConflicts !== 'function') { json(res, 501, { error: 'code merge not supported by this adapter' }); return; }
    json(res, 200, { conflicts: await db.listCodeConflicts() });
  });

  // The three text sides + base-informed pre-merge for one conflicted file (?path=). Git-sourced; returns
  // { status: 'git_required' } when BASE/REMOTE aren't recoverable in-app (resolve on the upgrade branch).
  router.get('/api/admin/upgrade/code/conflict', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.getCodeConflictContent !== 'function') { json(res, 501, { error: 'code merge not supported by this adapter' }); return; }
    const path = new URL(req.url ?? '', 'http://localhost').searchParams.get('path');
    if (!path) { json(res, 400, { error: 'path is required' }); return; }
    try { json(res, 200, await db.getCodeConflictContent(path)); }
    catch (err) { json(res, 502, { error: 'load conflict failed', detail: (err as Error).message }); }
  });

  // Three-way scan the code tree against the accepted release's git refs, recording real conflicts into the
  // review queue. Returns { status: 'git_required' } when the tree isn't git / refs are unavailable.
  router.post('/api/admin/upgrade/code/scan-release', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.scanCodeAgainstRelease !== 'function') { json(res, 501, { error: 'release scan not supported by this adapter' }); return; }
    try { json(res, 200, await db.scanCodeAgainstRelease()); }
    catch (err) { json(res, 502, { error: 'release scan failed', detail: (err as Error).message }); }
  });

  // Three-way scan sourcing BASE/REMOTE trees from GitHub (no local git checkout needed). The fetched target
  // tree is integrity-checked against the signed manifest before any conflict is recorded. A fetch/integrity
  // failure or an unconfigured source is returned as a typed status (not an error) so the UI can guide the fix.
  router.post('/api/admin/upgrade/code/scan-remote', async (_req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.scanCodeRemote !== 'function') { json(res, 501, { error: 'remote scan not supported by this adapter' }); return; }
    try { json(res, 200, await db.scanCodeRemote()); }
    catch (err) { json(res, 502, { error: 'remote scan failed', detail: (err as Error).message }); }
  });

  // Apply an operator's resolved content: { detailId, path, content }. Rejects a resolution that still carries
  // conflict markers (409) and a path escaping the source root (400).
  router.post('/api/admin/upgrade/code/conflict/resolve', async (req, res, _params, auth) => {
    if (!requirePlatformAdmin(res, auth)) return;
    if (typeof db.resolveCodeConflict !== 'function') { json(res, 501, { error: 'code merge not supported by this adapter' }); return; }
    let body: { detailId?: unknown; path?: unknown; content?: unknown } = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (typeof body.detailId !== 'string' || typeof body.path !== 'string' || typeof body.content !== 'string') {
      json(res, 400, { error: 'detailId, path, content are required strings' }); return;
    }
    try {
      const result = await db.resolveCodeConflict(body.detailId, body.path, body.content, { resolvedBy: auth!.userId });
      // A refusal (still-conflicted / path traversal) is a 409/400, not a 500 — the operator acts on it.
      json(res, result.ok ? 200 : (result.reason === 'path_escapes_root' ? 400 : 409), result);
    } catch (err) { json(res, 502, { error: 'resolve conflict failed', detail: (err as Error).message }); }
  });
}
