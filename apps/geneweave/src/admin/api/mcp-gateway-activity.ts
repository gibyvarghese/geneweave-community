/**
 * GeneWeave — Admin MCP Gateway Activity routes (Phase 8)
 *
 * Read-only endpoints surfacing the append-only mcp_gateway_request_log:
 * a per-client activity dashboard (counts + last-seen) and a recent
 * request feed for drill-in.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { MCPGatewayRequestOutcome } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

const VALID_OUTCOMES: ReadonlySet<string> = new Set([
  'ok', 'rate_limited', 'unauthorized', 'disabled', 'error',
]);

export function registerMCPGatewayActivityRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  /** Per-client aggregate counts over a window (default last 24 h). */
  router.get('/api/admin/mcp-gateway-activity/summary', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Accept either an explicit ISO `since` or a window like `24h`/`7d`.
    const sinceIso = resolveSince(url.searchParams.get('since'), url.searchParams.get('window'));
    const summary = await db.summarizeMCPGatewayActivity({ sinceIso });
    json(res, 200, { since: sinceIso, summary });
  }, { auth: true });

  /** Recent gateway requests, newest-first. */
  router.get('/api/admin/mcp-gateway-activity/recent', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const clientId = url.searchParams.get('client_id') ?? undefined;
    const outcomeRaw = url.searchParams.get('outcome');
    const outcome = outcomeRaw && VALID_OUTCOMES.has(outcomeRaw)
      ? (outcomeRaw as MCPGatewayRequestOutcome)
      : undefined;
    const limit = parseIntOr(url.searchParams.get('limit'), 100);
    const offset = parseIntOr(url.searchParams.get('offset'), 0);
    const events = await db.listMCPGatewayRequestLog({
      ...(clientId ? { clientId } : {}),
      ...(outcome ? { outcome } : {}),
      limit,
      offset,
    });
    json(res, 200, { events, limit, offset });
  }, { auth: true });
}

function parseIntOr(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve a window string ('24h', '7d', '1h') or explicit ISO into an ISO `since`. */
function resolveSince(sinceIso: string | null, windowSpec: string | null): string {
  if (sinceIso) return sinceIso;
  const match = (windowSpec ?? '24h').match(/^(\d+)\s*([hd])$/i);
  let ms = 24 * 60 * 60 * 1000;
  if (match && match[1] && match[2]) {
    const n = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (Number.isFinite(n) && n > 0) {
      ms = unit === 'd' ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000;
    }
  }
  return new Date(Date.now() - ms).toISOString();
}
