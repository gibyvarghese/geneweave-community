/**
 * /api/me — accessibility defaults for the client (m140).
 *
 *   GET /api/me/accessibility   this workspace's streaming-announce mode + reduced-motion default
 */
import type { DatabaseAdapter } from '../db.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createAccessibilityService } from '../accessibility-sql.js';

export function registerMeAccessibilityRoutes(router: Router, db: DatabaseAdapter): void {
  const svc = createAccessibilityService(db);
  router.get('/api/me/accessibility', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await svc.getConfig(auth.tenantId ?? 'default');
    json(res, 200, { announceMode: c.announce_mode, reducedMotion: c.reduced_motion === 1, alwaysShowFocus: c.always_show_focus === 1, confirmDestructive: c.confirm_destructive === 1, showSkeletons: c.show_skeletons === 1 });
  });
}
