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
}
