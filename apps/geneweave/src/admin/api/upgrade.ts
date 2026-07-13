// SPDX-License-Identifier: MIT
/**
 * Admin routes for the Upgrade Engine's `check` command.
 *
 *   • POST /api/admin/upgrade/check     — poll the release source, verify the manifest, record the outcome,
 *                                         and return it (update_available / up_to_date / rejected+reason / none).
 *   • GET  /api/admin/upgrade/status    — the most recent check.
 *   • POST /api/admin/upgrade/preflight — read-only gates on the latest accepted release (safe-to-apply?).
 *   • POST /api/admin/upgrade/preview   — read-only four-layer plan of what applying it would do (JSON).
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
  const { json } = helpers;

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
}
