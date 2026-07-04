/**
 * Run CONTROL CHANNEL over WebSocket (Collaboration Phase 6).
 *
 * SSE streams a run's output one way (server → client). This WebSocket is the
 * bidirectional CONTROL plane — the client talks BACK mid-run: cancel, steer,
 * heartbeat presence. We keep the two split on purpose (the mid-2026 consensus):
 * SSE for the token stream, WS only where the client must send.
 *
 * --- For someone new to this ---
 * A WebSocket is a two-way phone line that stays open. Here the browser uses it to
 * say things like "cancel this run" or "here is a steering note" while the run is
 * going. Because the line can drop (you switch tabs, your wifi blips), the moment
 * it reconnects the server sends a fresh SNAPSHOT of the current state, so control
 * + presence pick up where they left off — surviving a tab switch, not just a
 * page reload.
 *
 * Security (mid-2026 research — OWASP WebSocket cheat sheet, CSWSH):
 *  - **Origin allowlist** checked on the handshake (the primary cross-site
 *    WebSocket-hijacking defense — JS cannot forge `Origin`).
 *  - Auth is a single-use **ticket** in the query (never a cookie); identity is
 *    derived server-side from it, never trusted from the client.
 *  - Every control message carries a client `requestId` so cancel/steer are
 *    **idempotent** — safe to retry after a reconnect without double-acting.
 *  - A **max message size** guards against memory exhaustion (close 1009).
 *  - Role gating: only the OWNER may cancel; only collaborator+ may steer; any
 *    participant may heartbeat presence (the run's `resolveRunAccess` is the
 *    source of truth, re-checked per privileged action).
 */
import type { WebSocket as WsSocket } from 'ws';
import { createLogger } from '@weaveintel/core';
import type { DatabaseAdapter } from './db-types.js';
import type { MeRunExecutor } from './me-run-executor.js';
import { isTerminalRunStatus } from './me-run-executor.js';
import { resolveRunAccess, annotatePresenceRoles } from './shared-session-sql.js';
import { roleAtLeast, normalizePresenceStatus } from '@weaveintel/collab';
import { createSqlPresenceManager, withAgentPeer } from './presence-sql.js';
import { loadCollaborationConfig } from './collab-config.js';

const logger = createLogger('run-control-ws');

/** Max inbound control message size (bytes). Larger → close 1009 (policy violation). */
export const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
const HEARTBEAT_MS = 30_000;
const SEEN_REQUEST_CAP = 500;

/** Match `/api/me/runs/:runId/control` (optionally with a query string). */
export function matchRunControlPath(url: string): { runId: string } | null {
  const m = url.match(/^\/api\/me\/runs\/([^/?#]+)\/control(?:[/?#]|$)/);
  return m ? { runId: decodeURIComponent(m[1]!) } : null;
}

/**
 * Validate the `Origin` header against an allowlist (CSWSH defense). When no
 * allowlist is configured (single-origin dev), a same-host Origin is accepted and
 * a missing Origin (non-browser client, e.g. a Node test) is allowed; a PRESENT
 * cross-origin Origin is always rejected unless explicitly allowed.
 */
export function isAllowedWsOrigin(origin: string | undefined, opts: { allowed?: string[]; host?: string }): boolean {
  if (!origin) return true; // non-browser clients don't send Origin
  const allow = opts.allowed ?? [];
  if (allow.includes('*')) return true;
  if (allow.includes(origin)) return true;
  // Same-host fallback: the Origin's host matches the request Host header.
  try {
    if (opts.host) {
      const o = new URL(origin);
      const hostOnly = opts.host.split(':')[0];
      if (o.hostname === hostOnly || o.host === opts.host) return true;
    }
  } catch { /* malformed Origin → reject */ }
  return false;
}

export interface RunControlAuth {
  userId: string;
  tenantId: string | null;
  displayName?: string;
}

export interface RunControlDeps {
  db: DatabaseAdapter;
  runExecutor: MeRunExecutor;
}

/**
 * Drive a single control-channel connection. Sends a `state.snapshot` on connect,
 * then handles `ping` / `presence` / `cancel` / `steer` messages (idempotent via
 * `requestId`), with an app-level heartbeat. The run-access check is performed
 * up front AND re-checked before each privileged action.
 */
export async function handleRunControlConnection(ws: WsSocket, runId: string, auth: RunControlAuth, deps: RunControlDeps): Promise<void> {
  const { db, runExecutor } = deps;
  const seen = new Set<string>(); // requestIds already actioned (idempotency)
  let alive = true;

  const send = (obj: Record<string, unknown>): void => {
    try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* closed */ }
  };

  // Initial authorization — a non-participant never gets a channel.
  const access0 = await resolveRunAccess(db, runId, auth.userId).catch(() => null);
  if (!access0) { send({ type: 'error', error: 'forbidden' }); try { ws.close(1008, 'forbidden'); } catch { /* */ } return; }

  // Resume-beyond-reload: send the current run status + presence snapshot on connect.
  async function presenceSnapshot(): Promise<unknown[]> {
    try {
      const cfg = await loadCollaborationConfig(db);
      if (!cfg.enabled) return [];
      const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
      const run = access0!.run;
      const humans = await presence.list({ runId: run.id, tenantId: run.tenant_id ?? '__default__' });
      return await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
    } catch { return []; }
  }
  send({ type: 'state.snapshot', run: { id: access0.run.id, status: access0.run.status }, role: access0.role, presence: await presenceSnapshot() });

  // App-level heartbeat: ping; if a pong is not seen before the next tick, drop.
  let gotPong = true;
  const heartbeat = setInterval(() => {
    if (!gotPong) { try { ws.terminate(); } catch { /* */ } clearInterval(heartbeat); return; }
    gotPong = false;
    send({ type: 'ping' });
  }, HEARTBEAT_MS);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') (heartbeat as { unref: () => void }).unref();

  ws.on('message', (raw: Buffer | ArrayBuffer | string) => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
    if (text.length > MAX_CONTROL_MESSAGE_BYTES) { try { ws.close(1009, 'message too big'); } catch { /* */ } return; }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { send({ type: 'error', error: 'invalid json' }); return; }
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';
    const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : undefined;

    // Idempotency MUST be decided SYNCHRONOUSLY here — two messages with the same
    // requestId can arrive back-to-back, and the action below is async, so we
    // RESERVE the requestId now (before any await). A duplicate is acked without
    // re-acting; a reservation is rolled back if the action errors (so a genuine
    // retry after a transient failure still works).
    if (requestId && (type === 'cancel' || type === 'steer' || type === 'presence')) {
      if (seen.has(requestId)) { send({ type: 'ack', requestId, ok: true, duplicate: true }); return; }
      if (seen.size > SEEN_REQUEST_CAP) seen.clear(); // bounded memory
      seen.add(requestId);
    }
    const rollback = (): void => { if (requestId) seen.delete(requestId); };

    void (async () => {
      // Re-resolve access on every message (TOCTOU-safe — access can be revoked mid-session).
      const access = await resolveRunAccess(db, runId, auth.userId).catch(() => null);
      if (!access) { rollback(); send({ type: 'error', requestId, error: 'forbidden' }); try { ws.close(1008, 'forbidden'); } catch { /* */ } return; }
      const run = access.run;

      switch (type) {
        case 'ping': send({ type: 'pong' }); return;
        case 'pong': gotPong = true; return;

        case 'presence': {
          try {
            const cfg = await loadCollaborationConfig(db);
            if (cfg.enabled) {
              const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
              const scope = { runId: run.id, tenantId: run.tenant_id ?? '__default__' };
              const state = normalizePresenceStatus(msg['presence']);
              const rawName = typeof msg['displayName'] === 'string' ? (msg['displayName'] as string).slice(0, 64) : `User ${auth.userId.slice(0, 8)}`;
              const humans = await presence.heartbeat(scope, { userId: auth.userId, displayName: rawName, presence: state, peerType: 'human', ...(msg['cursor'] && typeof msg['cursor'] === 'object' ? { cursor: msg['cursor'] as Record<string, unknown> } : {}) });
              const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
              runExecutor.broadcastEphemeral(run.id, 'presence.update', { participants }); // fan out to SSE watchers
            }
          } catch { /* best-effort presence */ }
          send({ type: 'ack', requestId, ok: true }); // requestId already reserved synchronously
          return;
        }

        case 'cancel': {
          if (access.role !== 'owner') { rollback(); send({ type: 'error', requestId, error: 'forbidden: only the owner can cancel' }); return; }
          if (isTerminalRunStatus(run.status)) { send({ type: 'ack', requestId, ok: true, alreadyTerminal: true }); return; }
          try {
            const wasActive = runExecutor.cancel(run.id);
            await db.updateUserRunStatus(run.id, run.user_id, 'cancelled');
            if (!wasActive) await runExecutor.appendEvent(run.id, 'run.cancelled', {}).catch(() => {});
            send({ type: 'ack', requestId, ok: true, cancelled: true });
          } catch (err) { rollback(); send({ type: 'error', requestId, error: err instanceof Error ? err.message : 'cancel failed' }); }
          return;
        }

        case 'steer': {
          if (!roleAtLeast(access.role, 'collaborator')) { rollback(); send({ type: 'error', requestId, error: 'forbidden: viewers cannot steer' }); return; }
          if (isTerminalRunStatus(run.status)) { rollback(); send({ type: 'error', requestId, error: 'run is already finished' }); return; }
          try {
            const payload = (msg['payload'] && typeof msg['payload'] === 'object') ? msg['payload'] as Record<string, unknown> : { text: typeof msg['text'] === 'string' ? msg['text'] : '' };
            const sequence = await runExecutor.appendEvent(run.id, 'client.steer', { ...payload, by: auth.userId });
            if (requestId) seen.add(requestId);
            send({ type: 'ack', requestId, ok: true, sequence });
          } catch (err) { send({ type: 'error', requestId, error: err instanceof Error ? err.message : 'steer failed' }); }
          return;
        }

        default: rollback(); send({ type: 'error', requestId, error: `unknown message type: ${type}` });
      }
    })().catch((err) => logger.warn('control message handler error', { err: err instanceof Error ? err.message : String(err) }));
  });

  ws.on('pong', () => { gotPong = true; });
  ws.on('close', () => { alive = false; clearInterval(heartbeat); });
  ws.on('error', (err: Error) => { logger.warn('control ws error', { runId, err: err.message }); });
  void alive;
}
