/**
 * Phase 4 — Admin SSE endpoint for real-time live run event streaming.
 *
 * GET /api/admin/live-runs/:id/stream
 *
 * Streams step_started / step_completed events from the supervisor's
 * `bridgeRunState` callback via the process-singleton `LiveRunEventBus`.
 * Events are delivered as SSE `data:` lines containing JSON.
 *
 * Client connection flow:
 *   1. Client opens SSE connection to /api/admin/live-runs/{runId}/stream.
 *   2. Server immediately replays the last N events from the DB so the
 *      client doesn't miss history that landed before they connected.
 *   3. Server stays connected and pushes any new events as they arrive
 *      from the supervisor's onEvent callback.
 *   4. Server sends a keepalive comment every 15 s.
 *   5. On client disconnect, the server cleans up the listener.
 *
 * Auth: requires an authenticated session (same as other admin routes).
 */

import type { DatabaseAdapter } from '../db.js';
import type { Router } from '../server-core.js';
import { onLiveRunEvent, offLiveRunEvent, type LiveRunEventListener } from '../live-agents/live-run-event-bus.js';

export function registerAdminLiveRunStreamRoute(router: Router, db: DatabaseAdapter): void {
  router.get('/api/admin/live-runs/:id/stream', async (req, res, params, auth) => {
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }

    const runId = params['id'] ?? '';
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing run id' }));
      return;
    }

    // Verify the run exists (best-effort; fail-open so SSE still works).
    try {
      const run = await db.getLiveRun(runId);
      if (!run) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found' }));
        return;
      }
    } catch {
      // db.getLiveRun not available on all DB adapters; continue anyway
    }

    // Disable per-request timeout — SSE connections are long-lived.
    req.socket?.setTimeout(0);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Replay recent DB events so clients that connect mid-run don't miss history.
    try {
      const recentEvents = await db.listLiveRunEvents({ runId, limit: 100 });
      for (const ev of recentEvents) {
        if (res.writableEnded) break;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch {
      // best-effort replay — continue with live tail even if replay fails
    }

    if (res.writableEnded) return;

    // Subscribe to in-process events from the supervisor's onEvent callback.
    const listener: LiveRunEventListener = (event) => {
      if (res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client disconnected */
      }
    };
    onLiveRunEvent(runId, listener);

    // Keepalive comment every 15 s to prevent proxy timeouts.
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(keepalive);
      offLiveRunEvent(runId, listener);
    };

    req.socket?.once('close', cleanup);
    req.once?.('close', cleanup);
  }, { auth: true });
}
