/**
 * GeneWeave — Admin Tool Health routes (Phase 3)
 *
 * Read-only endpoints surfacing health data from tool_audit_events (live
 * 24 h summary) and tool_health_snapshots (historical trend data written
 * by the background 15-minute snapshot job).
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolHealthRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  /** Live 24-hour health summary — one row per active tool */
  router.get('/api/admin/tool-health', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Optional ISO timestamp; defaults to 24 h ago inside the adapter.
    const since = url.searchParams.get('since') ?? undefined;
    const summary = await db.getToolHealthSummary(since);
    json(res, 200, { summary });
  }, { auth: true });

  /** Historical snapshots for a specific tool (newest first, default last 48 snapshots) */
  router.get('/api/admin/tool-health/:toolName/snapshots', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '48', 10), 200);
    const snapshots = await db.listToolHealthSnapshots(params['toolName']!, limit);
    json(res, 200, { snapshots });
  }, { auth: true });
}
