/**
 * /api/me — User-scope API routes
 *
 * Provides interaction-model-agnostic endpoints for the weaveIntel platform:
 *
 *   Runs:
 *     POST   /api/me/runs                        create a new run
 *     GET    /api/me/runs                        list user's runs (filterable)
 *     GET    /api/me/runs/:runId                 get run record
 *     GET    /api/me/runs/:runId/events          SSE event stream (resumable)
 *     POST   /api/me/runs/:runId/events          post a client-originated event
 *     POST   /api/me/runs/:runId/cancel          cancel a running run
 *
 *   Catalog:
 *     GET    /api/me/catalog?surface=<id>        surface catalog for the caller
 *
 *   Theme:
 *     GET    /api/me/theme                       per-tenant design tokens
 *
 *   Tasks:
 *     GET    /api/me/tasks                       list action-item tasks
 *     POST   /api/me/tasks                       create action-item
 *     POST   /api/me/tasks/:taskId/complete      complete a task
 *     POST   /api/me/tasks/:taskId/cancel        cancel a task
 *
 *   Reminders:
 *     GET    /api/me/reminders                   list reminders
 *     POST   /api/me/reminders                   create a reminder trigger
 *     POST   /api/me/reminders/:id/reschedule    reschedule a one-shot reminder
 *     DELETE /api/me/reminders/:id               delete a reminder
 *
 *   Devices & notifications:
 *     POST   /api/me/devices                     register a push device
 *     DELETE /api/me/devices/:token              unregister a device
 *     GET    /api/me/notification-preferences    get preferences
 *     PUT    /api/me/notification-preferences    update preferences
 *
 * Chat compatibility shim (permanent — no deprecation):
 *   /api/chats endpoints are handled in routes/chat.ts and MUST remain.
 *
 * Vocabulary: no "chat", "conversation", "message" (HTTP sense), "turn"
 * in this file's public API surface.
 */

import { newUUIDv7, weaveContext, SSE_RESPONSE_HEADERS, resolveResumeCursor } from '@weaveintel/core';
import { createActionItem, completeActionItem, cancelActionItem } from '@weaveintel/human-tasks';
import { createReminderTrigger, rescheduleReminder } from '@weaveintel/triggers';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import { createMeCatalogResolver } from '../me-catalog.js';
import { resolveTenantThemeTokens } from '../tenant-theme.js';
import type { SurfaceCatalogResolver } from '@weaveintel/core';
import type { NotificationsHub } from '../notifications-wiring.js';
import { meTaskRepo as taskRepo, meTriggerStore as triggerStore } from './me-stores.js';
import { safePageInt } from './index.js';
import { MeRunExecutor, isTerminalRunStatus } from '../me-run-executor.js';
import { loadRunStreamConfig, clientStreamConfig } from '../chat-run-stream-utils.js';
import { runApprovals } from '../me-run-approvals.js';
import { createSqlRunJournal } from '../run-substrate-sql.js';
import { createSqlPresenceManager, withAgentPeer } from '../presence-sql.js';
import { loadCollaborationConfig, clientCollabConfig } from '../collab-config.js';
import { resolveRunAccess, createSqlSessionManager, mintShareToken, hashShareToken, annotatePresenceRoles } from '../shared-session-sql.js';
import { roleAtLeast, normalizePresenceStatus, type SessionRole, type SubscriptionChannel } from '@weaveintel/collab';
import { createSqlSubscriptionManager, createSqlFeedStore } from '../run-subscription-sql.js';
import { enqueueRunTerminalNotifications, isSafeWebhookUrl } from '../run-notifications-outbox.js';
import { createSqlCommentManager, createSqlAnnotationManager, mintPublicShareToken } from '../run-comment-sql.js';
import { summarizeAnnotations, annotationsToEvalExamples, type CommentAnchor, type AnnotationDataType, type AnnotationSource, type HandoffScope, type HandoffBriefing } from '@weaveintel/collab';
import { createSqlHandoffManager, buildRunBriefing } from '../handoff-sql.js';
import { createCoeditRepo, userSiteId } from '../coedit-sql.js';

/**
 * Register all /api/me routes on the provided router.
 *
 * @param router   The server Router instance
 * @param db       DatabaseAdapter (for runs, devices, prefs)
 * @param opts.runExecutor  Optional run executor. When supplied, `POST
 *   /api/me/runs` dispatches the run (producing live events) and the SSE
 *   stream live-tails appended events. When omitted, the run surface degrades
 *   to the historical record-only behaviour (create + manual events) so tests
 *   and embedded callers keep working with no executor wired.
 */
export function registerMeRoutes(
  router: Router,
  db: DatabaseAdapter,
  opts: {
    catalogResolver?: SurfaceCatalogResolver;
    notifications?: NotificationsHub;
    runExecutor?: MeRunExecutor;
    /** Phase 3 — the durable notification relay (lets endpoints drain immediately). */
    notificationRelay?: { drainOnce(): Promise<number> };
  } = {},
): void {

  const catalogResolver = opts.catalogResolver ?? createMeCatalogResolver(db);
  const notifications = opts.notifications;
  const notificationRelay = opts.notificationRelay;
  // A no-producing executor still provides the per-run SSE bus + serialized
  // append path, so the live-tail + resumable contract holds even when no
  // agent is wired (e.g. unit tests, embedded callers).
  const runExecutor = opts.runExecutor ?? new MeRunExecutor({ db });

  // ─── Runs ───────────────────────────────────────────────────────────────

  router.post('/api/me/runs', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Idempotency: check Idempotency-Key header
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
    if (idempotencyKey) {
      const existing = await db.getIdempotencyRecordByKey(idempotencyKey);
      if (existing) {
        const run = await db.getUserRun(existing.result_json ?? '', auth.userId);
        if (run) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(run));
          return;
        }
      }
    }

    const runId = newUUIDv7();
    await db.createUserRun({
      id: runId,
      user_id: auth.userId,
      status: 'pending',
      ...(auth.tenantId ? { tenant_id: auth.tenantId } : {}),
      ...(typeof body['surface'] === 'string' ? { surface: body['surface'] } : {}),
      ...(body['metadata'] !== undefined ? { metadata: JSON.stringify(body['metadata']) } : {}),
    });

    if (idempotencyKey) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.createIdempotencyRecord({
        id: newUUIDv7(),
        key: idempotencyKey,
        result_json: runId,
        expires_at: expiresAt,
      });
    }

    const run = await db.getUserRun(runId, auth.userId);

    // SP3: dispatch the run through the executor (non-blocking). The response
    // returns immediately; the run produces events + flips status in the
    // background. When no producing agent is wired the executor is a no-op and
    // the run stays `pending` (record-only behaviour preserved).
    if (runExecutor.canProduce) {
      runExecutor.start({
        runId,
        userId: auth.userId,
        ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
        ...(auth.persona !== undefined ? { persona: auth.persona } : {}),
        ...(typeof body['surface'] === 'string' ? { surface: body['surface'] } : {}),
        input: (typeof body['input'] === 'object' && body['input'] !== null)
          ? (body['input'] as Record<string, unknown>)
          : {},
        ...(typeof body['metadata'] === 'object' && body['metadata'] !== null
          ? { metadata: body['metadata'] as Record<string, unknown> }
          : {}),
      });
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(run));
  }, { auth: true });

  router.get('/api/me/runs', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const statusParam = url.searchParams.get('status');
    const limit = safePageInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = safePageInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
    type RunStatus = 'pending'|'running'|'completed'|'failed'|'cancelled';
    const validStatuses: RunStatus[] = ['pending','running','completed','failed','cancelled'];
    const status = validStatuses.includes(statusParam as RunStatus) ? statusParam as RunStatus : undefined;
    const runs = await db.listUserRuns(auth.userId, { status, limit, offset });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runs }));
  }, { auth: true });

  // Client run/stream tuning (sourced from the `run_stream_config` DB row).
  // Registered BEFORE `/:runId` so the literal path wins over the param route.
  // Clients (@weaveintel/client / geneweave-ui) fetch this and apply the
  // reconnect backoff / throttle so DB changes drive client behaviour.
  router.get('/api/me/runs/config', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await loadRunStreamConfig(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientStreamConfig(cfg)));
  }, { auth: true });

  // Collaboration Phase 1: presence cadence (heartbeat/TTL), DB-driven. Clients
  // fetch this and heartbeat at `presenceHeartbeatMs`.
  router.get('/api/me/collab/config', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await loadCollaborationConfig(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientCollabConfig(cfg)));
  }, { auth: true });

  router.get('/api/me/runs/:runId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant (owner / collaborator / viewer) may VIEW the run.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...access.run, role: access.role }));
  }, { auth: true });

  // SSE event stream — resumable. Resume cursor precedence (Collaboration Phase 6):
  // the standard `Last-Event-ID` header (sent automatically by a browser
  // EventSource on reconnect) wins, then the explicit `?after=<sequence>` query,
  // else from the start. Each journaled event is written with `id: <sequence>`,
  // so a dropped browser stream re-attaches and replays only the gap.
  router.get('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant may READ the live stream (viewers watch).
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;

    const url = new URL(req.url ?? '/', 'http://x');
    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? null;
    const afterSeq = resolveResumeCursor({ lastEventId, afterParam: url.searchParams.get('after'), defaultAfter: -1 });

    // Keepalive cadence comes from `run_stream_config` (DB), not a hardcoded 15s.
    const streamCfg = await loadRunStreamConfig(db);

    res.writeHead(200, { ...SSE_RESPONSE_HEADERS });
    // Tell EventSource how long to wait before reconnecting (WHATWG `retry:`, ms).
    const retryMs = Array.isArray(streamCfg.backoffMs) ? (streamCfg.backoffMs[0] ?? 3000) : 3000;
    res.write(`retry: ${Math.max(1000, retryMs)}\n\n`);

    // Subscribe FIRST so any event appended during the replay window is
    // buffered (not lost). The subscriber dedups by sequence, so the
    // replay→live handoff is gap-free and duplicate-free.
    const { subscriber, detach } = runExecutor.subscribe(run.id, res, afterSeq, auth.userId);

    // Replay all persisted events after the cursor — THROUGH the core RunJournal
    // port (Collaboration Phase 0). `createSqlRunJournal` is the SQL adapter over
    // `user_run_events`; reading via the port (instead of the raw db method) is
    // what makes geneWeave's run pipeline run on the one canonical contract.
    // `journalMaxEvents` bounds the journal, so it bounds the replay too.
    const journal = createSqlRunJournal(db);
    const events = await journal.readAfter(
      { runId: run.id, afterSequence: afterSeq },
      { limit: streamCfg.journalMaxEvents },
    );
    for (const ev of events) {
      subscriber.replay({
        runId: run.id,
        sequence: ev.sequence,
        kind: ev.kind,
        payload: ev.payload,
        timestamp: ev.timestamp ?? Date.now(),
      });
    }

    // Collaboration Phase 1: send the CURRENT presence snapshot to the new
    // subscriber so it immediately sees who else is watching (presence is
    // ephemeral, so it is NOT in the journal above — it's read live here).
    try {
      const collabCfg = await loadCollaborationConfig(db);
      if (collabCfg.enabled) {
        const presence = createSqlPresenceManager(db, { ttlMs: collabCfg.presenceTtlMs });
        const humans = await presence.list({ runId: run.id, tenantId: run.tenant_id ?? '__default__' });
        const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, collabCfg.showAgentPresence), db, run);
        if (participants.length > 0) {
          subscriber.replay({ runId: run.id, sequence: -1, kind: 'presence.update', payload: { participants }, timestamp: Date.now() });
        }
      }
    } catch { /* presence snapshot is best-effort — never break the stream */ }

    // For terminal runs with nothing more coming, close after replay.
    if (isTerminalRunStatus(run.status)) {
      detach();
      if (!res.writableEnded) res.end();
      return;
    }

    // Flush buffered live events, then live-tail until the client disconnects
    // or a terminal event closes the stream.
    subscriber.activate();
    // Keepalive AND continuous re-authorization (CVE-2026-53843, defense in
    // depth). An SSE read is authorized once at connect; a viewer removed from
    // the shared session mid-stream is force-disconnected immediately by the
    // mutating endpoint (see /members/remove, /share/end), but we ALSO re-check
    // access on every keepalive tick so that ANY revocation path — including a
    // future one, or a cross-process removal on another node — eventually closes
    // a now-unauthorized stream rather than streaming to it forever. The owner
    // always retains access, so this never closes the owner's own stream.
    let reauthInFlight = false;
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); return; }
      if (reauthInFlight) return;
      reauthInFlight = true;
      void resolveRunAccess(db, run.id, auth.userId)
        .then((acc) => {
          if (!acc) { subscriber.revoke('access revoked'); detach(); clearInterval(keepalive); }
        })
        .catch(() => { /* transient DB error — keep the stream, re-check next tick */ })
        .finally(() => { reauthInFlight = false; });
    }, Math.max(1000, streamCfg.heartbeatMs));
    req.socket?.on('close', () => { clearInterval(keepalive); detach(); });
  }, { auth: true });

  router.post('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: posting control events (input, approval decisions, steering) is a
    // WRITE — only owner + collaborator. A viewer who finds the run gets 403.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot send control events' })); return; }
    const run = access.run;
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    const kind = typeof body['kind'] === 'string' ? body['kind'] : 'client.event';
    const payload = (typeof body['payload'] === 'object' && body['payload'] !== null)
      ? (body['payload'] as Record<string, unknown>)
      : body;

    // Phase 4: an approval decision resolves a pending HITL approval (resumes or
    // denies the paused run) rather than being recorded as a plain client event.
    if (kind === 'approval.decision') {
      const taskId = typeof payload['taskId'] === 'string' ? payload['taskId'] : '';
      const rawAction = payload['action'];
      const action = rawAction === 'approve' || rawAction === 'reject' || rawAction === 'modify' ? rawAction : 'reject';
      const resolved = taskId
        ? await runApprovals.resolve(taskId, action, {
            ...(typeof payload['feedback'] === 'string' ? { feedback: payload['feedback'] } : {}),
            ...(payload['modifiedArgs'] && typeof payload['modifiedArgs'] === 'object' ? { modifiedArgs: payload['modifiedArgs'] as Record<string, unknown> } : {}),
            decidedBy: auth.userId,
          })
        : false;
      res.writeHead(resolved ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resolved }));
      return;
    }

    // Append + broadcast through the executor so client-originated events are
    // serialized with executor writes (gap-free sequence) and fanned out live.
    const sequence = await runExecutor.appendEvent(run.id, kind, payload);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sequence }));
  }, { auth: true });

  // ── Presence (Collaboration Phase 1) — "who else is watching this run" ──────
  // POST = heartbeat (or `{ leave: true }` to leave). Identity is ALWAYS the
  // authenticated user (`auth.userId`) — never client-supplied — so presence
  // cannot be spoofed. `displayName` is a cosmetic label (capped, no PII). Each
  // heartbeat broadcasts the full participant snapshot to the run's live
  // subscribers and returns it to the caller. Presence is ephemeral (its own
  // `run_presence` table) and never journaled.
  router.post('/api/me/runs/:runId/presence', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant (incl. viewers) may show presence on a run they
    // can access — that's what makes multi-user "who's watching" work.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;

    const cfg = await loadCollaborationConfig(db);
    if (!cfg.enabled) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ participants: [] })); return; }
    const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
    const scope = { runId: run.id, tenantId: run.tenant_id ?? '__default__' };

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty body = plain heartbeat */ }

    let humans;
    if (body['leave'] === true) {
      humans = await presence.leave(scope, auth.userId);
    } else {
      const rawName = typeof body['displayName'] === 'string' ? body['displayName'] : `User ${auth.userId.slice(0, 8)}`;
      const state = normalizePresenceStatus(body['presence']);
      humans = await presence.heartbeat(scope, {
        userId: auth.userId,                       // server-derived identity (anti-spoof)
        displayName: rawName.slice(0, 64),         // cosmetic, length-capped, no PII
        presence: state,
        peerType: 'human',
        ...(body['cursor'] && typeof body['cursor'] === 'object' ? { cursor: body['cursor'] as Record<string, unknown> } : {}),
      });
    }
    const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
    // Push the new snapshot to everyone watching (ephemeral — not journaled).
    runExecutor.broadcastEphemeral(run.id, 'presence.update', { participants });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants }));
  }, { auth: true });

  router.get('/api/me/runs/:runId/presence', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId); // any participant
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;
    const cfg = await loadCollaborationConfig(db);
    const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
    const humans = await presence.list({ runId: run.id, tenantId: run.tenant_id ?? '__default__' });
    const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants }));
  }, { auth: true });

  router.post('/api/me/runs/:runId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: cancelling is an OWNER-only action (a higher tier than write).
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (access.role !== 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: only the owner can cancel the run' })); return; }
    const run = access.run;
    if (isTerminalRunStatus(run.status)) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'Run already in terminal state' })); return;
    }
    // Cooperatively abort the in-flight agent (if any). When a producing run
    // is active its loop emits the terminal `run.cancelled` event; otherwise
    // we flip status + append the terminal event ourselves.
    const wasActive = runExecutor.cancel(params['runId']!);
    await db.updateUserRunStatus(params['runId']!, auth.userId, 'cancelled');
    if (!wasActive) {
      await runExecutor.appendEvent(params['runId']!, 'run.cancelled', {}).catch(() => {});
    }
    if (notifications) {
      const updated = await db.getUserRun(params['runId']!, auth.userId);
      if (updated) {
        void notifications.notifyRunTerminal(updated, { attached: runExecutor.hasSubscriber(updated.id) }).catch(() => {});
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cancelled' }));
  }, { auth: true });

  // ── Shared sessions + invite links (Collaboration Phase 2) ──────────────────
  // Share a run: OWNER-only. Creates the shared session (idempotent per run) and
  // mints an invite token granting `role` (default viewer). The plaintext token
  // is returned ONCE — only its SHA-256 hash is stored.
  router.post('/api/me/runs/:runId/share', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (access.role !== 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: only the owner can share a run' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* default viewer */ }
    const role: SessionRole = body['role'] === 'collaborator' ? 'collaborator' : 'viewer'; // never mint an owner link
    const cfg = await loadCollaborationConfig(db);

    const sessions = createSqlSessionManager(db);
    const session = await sessions.createSession({ id: newUUIDv7(), runId: run.id, tenantId: run.tenant_id ?? '__default__', ownerId: auth.userId, maxParticipants: cfg.maxParticipantsPerRun });

    const { token, hash, prefix } = mintShareToken();
    const expiresAt = typeof body['expiresInMs'] === 'number' ? Date.now() + (body['expiresInMs'] as number) : null;
    const tokenId = newUUIDv7();
    await db.createShareToken({ id: tokenId, session_id: session.id, tenant_id: run.tenant_id ?? '__default__', role, token_hash: hash, token_prefix: prefix, ...(typeof body['maxUses'] === 'number' ? { max_uses: body['maxUses'] as number } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}), created_by: auth.userId, created_at: Date.now() });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId: session.id, token, tokenId, role, expiresAt, url: `/shared/${token}` }));
  }, { auth: true });

  // Join via an invite token. Authenticated join (identity is server-derived).
  // Validates the token (hash match, live, not expired/revoked, under caps),
  // then idempotently creates the membership and returns the run id + role.
  router.post('/api/me/sessions/join', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* invalid */ }
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing token' })); return; }

    const row = await db.getShareTokenByHash(hashShareToken(token));
    const now = Date.now();
    // Uniform rejection (don't reveal which check failed → no enumeration).
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < now) || (row.max_uses !== null && row.uses >= row.max_uses)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid or expired link' })); return;
    }
    const session = await db.getSharedSessionById(row.session_id);
    if (!session || session.status !== 'live') { res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid or expired link' })); return; }
    // Tenant gate: the token's tenant must match the joiner's session tenant.
    // (Both were stamped server-side; a cross-tenant token simply won't resolve.)

    const sessions = createSqlSessionManager(db);
    try {
      const participant = await sessions.join(session.id, auth.userId, row.role as SessionRole);
      await db.incrementShareTokenUses(row.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runId: session.run_id, sessionId: session.id, role: participant.role }));
    } catch (err) {
      res.writeHead(409); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Could not join' }));
    }
  }, { auth: true });

  // Read the shared session + its participants (any participant).
  router.get('/api/me/runs/:runId/session', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const sessions = createSqlSessionManager(db);
    const session = await sessions.getByRun(access.run.id);
    if (!session) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ shared: false, role: access.role, participants: [] })); return; }
    const participants = await sessions.listParticipants(session.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shared: true, sessionId: session.id, ownerId: session.ownerId, role: access.role, participants }));
  }, { auth: true });

  // Revoke an invite token (OWNER-only) — already-joined members keep access
  // until removed; the link stops admitting new joiners.
  router.post('/api/me/runs/:runId/share/revoke', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden' : 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const tokenId = typeof body['tokenId'] === 'string' ? body['tokenId'] : '';
    if (!tokenId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing tokenId' })); return; }
    await db.revokeShareToken(tokenId, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: true }));
  }, { auth: true });

  // Remove a member from the shared run (OWNER-only). CVE-2026-53843: removing a
  // member must IMMEDIATELY force-close any live SSE stream they hold — an SSE
  // read is authorized only at connect, so without this a removed viewer keeps
  // receiving events until they happen to reconnect. We drop the membership row
  // first, then disconnect every live stream whose viewer no longer resolves to
  // access, then broadcast a fresh presence snapshot so the avatars update.
  router.post('/api/me/runs/:runId/members/remove', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden: only the owner can remove members' : 'Not found' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const targetUserId = typeof body['userId'] === 'string' ? body['userId'] : '';
    if (!targetUserId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing userId' })); return; }
    if (targetUserId === auth.userId) { res.writeHead(400); res.end(JSON.stringify({ error: 'The owner cannot remove themselves' })); return; }

    const sessions = createSqlSessionManager(db);
    const session = await sessions.getByRun(run.id);
    if (session) {
      await sessions.removeParticipant(session.id, auth.userId, targetUserId).catch(() => { /* idempotent */ });
    }
    // Force-close the removed user's live stream(s) right now. `resolveRunAccess`
    // is the single source of truth for who may watch, so we close any stream
    // whose user no longer resolves to access (the removed user, specifically).
    const closed = runExecutor.disconnectUnauthorized(run.id, (uid) => uid !== targetUserId, 'removed from shared run');
    // Drop their presence + push a refreshed snapshot to remaining watchers.
    const cfg = await loadCollaborationConfig(db);
    try {
      const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
      const humans = await presence.leave({ runId: run.id, tenantId: run.tenant_id ?? '__default__' }, targetUserId);
      const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
      runExecutor.broadcastEphemeral(run.id, 'presence.update', { participants });
    } catch { /* presence refresh is best-effort */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed: true, streamsClosed: closed }));
  }, { auth: true });

  // End sharing entirely (OWNER-only): marks the session ended, revokes all
  // tokens, and force-closes every non-owner live stream (CVE-2026-53843).
  router.post('/api/me/runs/:runId/share/end', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden' : 'Not found' })); return; }
    const run = access.run;
    const sessions = createSqlSessionManager(db);
    const session = await sessions.getByRun(run.id);
    if (session) await sessions.endSession(session.id, auth.userId).catch(() => {});
    // After endSession only the owner still resolves to access; close the rest.
    const closed = runExecutor.disconnectUnauthorized(run.id, (uid) => uid === auth.userId, 'sharing ended by owner');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ended: true, streamsClosed: closed }));
  }, { auth: true });

  // ── Durable subscriptions + offline notifications (Collaboration Phase 3) ────
  // Subscribe to a run: "notify me when it finishes, even if I close the tab."
  // Any participant (owner / collaborator / viewer) may subscribe to a run they
  // can access. Identity is server-derived. Channels default to `inapp` (always
  // included); `webhook`/`push`/`email` are opt-in.
  router.post('/api/me/runs/:runId/subscribe', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* default inapp */ }
    const allowed: SubscriptionChannel[] = ['inapp', 'email', 'push', 'webhook'];
    const channels = Array.isArray(body['channels'])
      ? (body['channels'] as unknown[]).filter((c): c is SubscriptionChannel => typeof c === 'string' && (allowed as string[]).includes(c))
      : undefined;
    const subs = createSqlSubscriptionManager(db);
    const sub = await subs.subscribe({ runId: run.id, tenantId: run.tenant_id ?? '__global__', userId: auth.userId, ...(channels ? { channels } : {}) });
    // If the run is ALREADY terminal at subscribe time, enqueue immediately so a
    // late subscriber still gets the "it's done" notification (no lost edge).
    if (isTerminalRunStatus(run.status)) {
      await enqueueRunTerminalNotifications(db, run).catch(() => {});
      await notificationRelay?.drainOnce().catch(() => {});
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subscribed: true, runId: run.id, channels: sub.channels }));
  }, { auth: true });

  // Unsubscribe (idempotent).
  router.post('/api/me/runs/:runId/unsubscribe', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    await createSqlSubscriptionManager(db).unsubscribe(access.run.id, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subscribed: false }));
  }, { auth: true });

  // Am I subscribed to this run? (drives the bell toggle in the UI)
  router.get('/api/me/runs/:runId/subscription', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const sub = await createSqlSubscriptionManager(db).get(access.run.id, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subscribed: sub !== null, channels: sub?.channels ?? [] }));
  }, { auth: true });

  // The in-app notification feed (the 🔔 bell inbox). `?unread=1` filters; the
  // feed is strictly the caller's own (server-derived principal) — no cross-user
  // access. `unreadCount` powers the badge.
  router.get('/api/me/notifications', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const unreadOnly = url.searchParams.get('unread') === '1';
    const limit = safePageInt(url.searchParams.get('limit'), 50, 1, 200);
    const tenantId = auth.tenantId ?? '__global__';
    const feed = createSqlFeedStore(db);
    const items = await feed.list(tenantId, auth.userId, { limit, unreadOnly });
    const unreadCount = await feed.unreadCount(tenantId, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, unreadCount }));
  }, { auth: true });

  // Mark one notification read.
  router.post('/api/me/notifications/:id/read', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const changed = await createSqlFeedStore(db).markRead(auth.tenantId ?? '__global__', auth.userId, params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ read: changed }));
  }, { auth: true });

  // Mark all read (single UPDATE).
  router.post('/api/me/notifications/read-all', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const count = await createSqlFeedStore(db).markAllRead(auth.tenantId ?? '__global__', auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ read: count }));
  }, { auth: true });

  // Register an outbound webhook endpoint (so `webhook`-channel subscriptions can
  // fire). SECURITY: the URL is validated here (https + not a private/link-local
  // host) AND again at dial time by the SSRF-hardened fetch in the relay. A
  // per-endpoint signing secret is generated server-side and returned ONCE.
  router.post('/api/me/webhooks', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const rawUrl = typeof body['url'] === 'string' ? body['url'].trim() : '';
    if (!isSafeWebhookUrl(rawUrl)) { res.writeHead(400); res.end(JSON.stringify({ error: 'URL must be https and not a private/loopback/link-local host' })); return; }
    const secret = `whsec_${mintShareToken().token}`;
    const id = newUUIDv7();
    await db.createWebhookEndpoint({ id, tenant_id: auth.tenantId ?? null, user_id: auth.userId, url: rawUrl, signing_secret: secret, created_at: Date.now() });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, url: rawUrl, signingSecret: secret })); // secret shown once
  }, { auth: true });

  // List my registered webhook endpoints (secrets never returned).
  router.get('/api/me/webhooks', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const eps = (await db.listWebhookEndpoints(auth.userId)).map((e) => ({ id: e.id, url: e.url, createdAt: e.created_at }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ endpoints: eps }));
  }, { auth: true });

  // Revoke a webhook endpoint.
  router.post('/api/me/webhooks/:id/revoke', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const changed = await db.revokeWebhookEndpoint(params['id']!, auth.userId, Date.now());
    res.writeHead(changed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: changed > 0 }));
  }, { auth: true });

  // ── Collaborative run timeline: comments + annotations (Phase 4) ─────────────
  // Validate @mentions against run ACCESS (a mention of someone who cannot see the
  // run is dropped — fail closed, no enumeration), cap the count (anti mention-
  // bombing), then notify each mentioned user via the Phase 3 in-app feed.
  const MENTION_CAP = 20;
  async function validateAndNotifyMentions(run: { id: string; tenant_id?: string | null }, requested: string[], actorId: string): Promise<string[]> {
    const unique = [...new Set(requested)].filter((u) => u && u !== actorId).slice(0, MENTION_CAP);
    const valid: string[] = [];
    for (const uid of unique) {
      const acc = await resolveRunAccess(db, run.id, uid).catch(() => null);
      if (acc) valid.push(uid);
    }
    if (valid.length) {
      const feed = createSqlFeedStore(db);
      const tenantId = run.tenant_id ?? '__global__';
      for (const uid of valid) {
        await feed.append({
          id: newUUIDv7(), tenantId, principalId: uid, category: 'mention',
          title: 'You were mentioned on a run', deepLink: `geneweave://run/${run.id}`,
          priority: 'normal', createdAt: Date.now(), readAt: null,
          dedupeKey: `mention:${run.id}:${newUUIDv7()}`, // each mention is its own notification
        }).catch(() => { /* best-effort */ });
      }
    }
    return valid;
  }

  // Create a comment (root or reply). ANY run participant may comment (a viewer is
  // a reviewer). The comment is anchored to a stable part id; the body is stored
  // raw + rendered to sanitized HTML by the SQL adapter.
  router.post('/api/me/runs/:runId/comments', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const text = typeof body['body'] === 'string' ? body['body'] : '';
    if (!text.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Empty comment' })); return; }
    const rawAnchor = (body['anchor'] && typeof body['anchor'] === 'object') ? body['anchor'] as Record<string, unknown> : {};
    const anchor: CommentAnchor = {
      partId: typeof rawAnchor['partId'] === 'string' ? (rawAnchor['partId'] as string).slice(0, 128) : '',
      createdAtSeq: typeof rawAnchor['createdAtSeq'] === 'number' ? rawAnchor['createdAtSeq'] as number : 0,
      ...(rawAnchor['subRange'] && typeof rawAnchor['subRange'] === 'object' ? { subRange: rawAnchor['subRange'] as CommentAnchor['subRange'] } : {}),
    };
    const parentId = typeof body['parentId'] === 'string' ? body['parentId'] : null;
    // Object-level authz: a reply's parent must belong to THIS run.
    if (parentId) {
      const parent = await db.getRunComment(parentId);
      if (!parent || parent.run_id !== run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Parent comment not found' })); return; }
    }
    const requestedMentions = Array.isArray(body['mentions']) ? (body['mentions'] as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const mentions = await validateAndNotifyMentions(run, requestedMentions, auth.userId);
    const comments = createSqlCommentManager(db);
    const comment = await comments.create({ id: newUUIDv7(), runId: run.id, tenantId: run.tenant_id ?? '__global__', authorId: auth.userId, body: text, anchor, mentions, ...(parentId ? { parentId } : {}) });
    runExecutor.broadcastEphemeral(run.id, 'comment.added', { comment });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comment }));
  }, { auth: true });

  // List all comments on a run (with viewer capabilities computed server-side).
  router.get('/api/me/runs/:runId/comments', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const comments = await createSqlCommentManager(db).listForRun(access.run.id);
    const isOwner = access.role === 'owner';
    const decorated = comments.map((c) => ({
      ...c,
      viewerCanEdit: c.authorId === auth.userId && !c.deletedAt,
      viewerCanDelete: (c.authorId === auth.userId || isOwner) && !c.deletedAt,
      viewerCanResolve: true, // any participant may resolve/reopen a thread
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comments: decorated, role: access.role }));
  }, { auth: true });

  // Edit a comment — AUTHOR ONLY (enforced in the adapter; re-validated here).
  router.post('/api/me/runs/:runId/comments/:commentId/edit', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const existing = await db.getRunComment(params['commentId']!);
    if (!existing || existing.run_id !== access.run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Comment not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const text = typeof body['body'] === 'string' ? body['body'] : '';
    if (!text.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Empty comment' })); return; }
    const requestedMentions = Array.isArray(body['mentions']) ? (body['mentions'] as unknown[]).filter((m): m is string => typeof m === 'string') : undefined;
    const mentions = requestedMentions ? await validateAndNotifyMentions(access.run, requestedMentions, auth.userId) : undefined;
    try {
      const comments = createSqlCommentManager(db);
      const updated = await comments.edit(params['commentId']!, auth.userId, text, mentions);
      runExecutor.broadcastEphemeral(access.run.id, 'comment.updated', { comment: updated });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ comment: updated }));
    } catch (err) {
      res.writeHead(403); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Forbidden' }));
    }
  }, { auth: true });

  // Delete a comment — author always; the run OWNER may moderate others'.
  router.post('/api/me/runs/:runId/comments/:commentId/delete', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const existing = await db.getRunComment(params['commentId']!);
    if (!existing || existing.run_id !== access.run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Comment not found' })); return; }
    try {
      await createSqlCommentManager(db).softDelete(params['commentId']!, auth.userId, { force: access.role === 'owner' });
      runExecutor.broadcastEphemeral(access.run.id, 'comment.deleted', { id: params['commentId'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch (err) {
      res.writeHead(403); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Forbidden' }));
    }
  }, { auth: true });

  // Resolve / reopen a thread (any participant).
  for (const action of ['resolve', 'reopen'] as const) {
    router.post(`/api/me/runs/:runId/threads/:threadId/${action}`, async (_req, res, params, auth) => {
      if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      const access = await resolveRunAccess(db, params['runId']!, auth.userId);
      if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const root = await db.getRunComment(params['threadId']!);
      if (!root || root.run_id !== access.run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Thread not found' })); return; }
      const comments = createSqlCommentManager(db);
      if (action === 'resolve') await comments.resolveThread(params['threadId']!, auth.userId);
      else await comments.reopenThread(params['threadId']!, auth.userId);
      runExecutor.broadcastEphemeral(access.run.id, `comment.${action}d`, { threadId: params['threadId'], by: auth.userId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ [action === 'resolve' ? 'resolved' : 'reopened']: true }));
    }, { auth: true });
  }

  // Create an annotation (structured score) on a run/part. Any participant.
  router.post('/api/me/runs/:runId/annotations', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const name = typeof body['name'] === 'string' ? body['name'].slice(0, 128) : '';
    if (!name) { res.writeHead(400); res.end(JSON.stringify({ error: 'Annotation name required' })); return; }
    const dataTypes = ['numeric', 'categorical', 'boolean', 'text'];
    const dataType = (typeof body['dataType'] === 'string' && dataTypes.includes(body['dataType'])) ? body['dataType'] as AnnotationDataType : 'numeric';
    const sources = ['human', 'llm_judge', 'eval_code', 'api', 'end_user'];
    const source = (typeof body['source'] === 'string' && sources.includes(body['source'])) ? body['source'] as AnnotationSource : 'human';
    const annotations = createSqlAnnotationManager(db);
    const ann = await annotations.create({
      id: newUUIDv7(), runId: access.run.id, tenantId: access.run.tenant_id ?? '__global__', authorId: auth.userId,
      name, dataType, source,
      value: typeof body['value'] === 'number' ? body['value'] : null,
      stringValue: typeof body['stringValue'] === 'string' ? (body['stringValue'] as string).slice(0, 512) : null,
      comment: typeof body['comment'] === 'string' ? (body['comment'] as string).slice(0, 2000) : null,
      partId: typeof body['partId'] === 'string' ? (body['partId'] as string).slice(0, 128) : '',
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ annotation: ann }));
  }, { auth: true });

  // List annotations + per-name summary (counts + numeric averages).
  router.get('/api/me/runs/:runId/annotations', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const annotations = await createSqlAnnotationManager(db).listForRun(access.run.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ annotations, summary: summarizeAnnotations(annotations) }));
  }, { auth: true });

  // Delete an annotation (author; owner may moderate).
  router.post('/api/me/runs/:runId/annotations/:id/delete', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const existing = await db.getRunAnnotation(params['id']!);
    if (!existing || existing.run_id !== access.run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Annotation not found' })); return; }
    try {
      await createSqlAnnotationManager(db).delete(params['id']!, auth.userId, { force: access.role === 'owner' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch (err) {
      res.writeHead(403); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Forbidden' }));
    }
  }, { auth: true });

  // Export a run's annotations as eval-dataset examples (the "lands in a dataset" bridge).
  router.get('/api/me/runs/:runId/annotations/export', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const annotations = await createSqlAnnotationManager(db).listForRun(access.run.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId: access.run.id, examples: annotationsToEvalExamples(annotations) }));
  }, { auth: true });

  // Mint a PUBLIC read-only share link (OWNER only). The token is shown ONCE;
  // only its SHA-256 hash is stored. The public route renders a redacted, no-write view.
  router.post('/api/me/runs/:runId/public-share', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden: only the owner can publish a run' : 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const { token, hash, prefix } = mintPublicShareToken();
    const expiresAt = typeof body['expiresInMs'] === 'number' ? Date.now() + (body['expiresInMs'] as number) : null;
    const id = newUUIDv7();
    await db.createRunPublicShare({ id, run_id: access.run.id, tenant_id: access.run.tenant_id ?? null, token_hash: hash, token_prefix: prefix, created_by: auth.userId, created_at: Date.now(), ...(expiresAt ? { expires_at: expiresAt } : {}) });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, token, url: `/share/runs/${token}`, expiresAt })); // token shown once
  }, { auth: true });

  // Revoke a public share link (OWNER only).
  router.post('/api/me/runs/:runId/public-share/revoke', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden' : 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing id' })); return; }
    const changed = await db.revokeRunPublicShare(id, access.run.id, Date.now());
    res.writeHead(changed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: changed > 0 }));
  }, { auth: true });

  // ── Unified handoff (Collaboration Phase 5) ──────────────────────────────────
  // A small helper: drop an in-app notification (Phase 3 feed) to a user about a
  // handoff, and push a live `handoff.update` to everyone watching the run.
  async function notifyHandoff(runId: string, tenantId: string | null, toUserId: string, title: string): Promise<void> {
    try {
      await createSqlFeedStore(db).append({
        id: newUUIDv7(), tenantId: tenantId ?? '__global__', principalId: toUserId,
        category: 'handoff', title, deepLink: `geneweave://run/${runId}`, priority: 'high',
        createdAt: Date.now(), readAt: null, dedupeKey: `handoff:${runId}:${newUUIDv7()}`,
      });
    } catch { /* best-effort */ }
  }

  const HANDOFF_SCOPES: HandoffScope[] = ['user_to_user', 'agent_to_human', 'agent_to_agent'];
  const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000; // 24h SLA

  // Request a handoff on a run. You must have run access to hand it off. The
  // recipient (`toUserId`) is notified and lands in their inbox. Context travels
  // as a SCOPED briefing (auto-built from the run unless one is supplied).
  router.post('/api/me/runs/:runId/handoff', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const toUserId = typeof body['toUserId'] === 'string' ? body['toUserId'] : '';
    if (!toUserId) { res.writeHead(400); res.end(JSON.stringify({ error: 'toUserId required' })); return; }
    if (toUserId === auth.userId) { res.writeHead(400); res.end(JSON.stringify({ error: 'cannot hand off to yourself' })); return; }
    const reason = typeof body['reason'] === 'string' ? body['reason'].slice(0, 1000) : '';
    if (!reason.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'a reason is required' })); return; }
    const scope: HandoffScope = (typeof body['scope'] === 'string' && (HANDOFF_SCOPES as string[]).includes(body['scope'])) ? body['scope'] as HandoffScope : 'user_to_user';
    // The recipient must exist (no leaking via mention of a ghost user).
    const recipient = await db.getUserById(toUserId).catch(() => null);
    if (!recipient) { res.writeHead(404); res.end(JSON.stringify({ error: 'recipient not found' })); return; }
    // Scoped context briefing: caller override merged over an auto-summary of the run.
    const overrides = (body['briefing'] && typeof body['briefing'] === 'object') ? body['briefing'] as Partial<HandoffBriefing> : {};
    const briefing = await buildRunBriefing(db, run, overrides);
    const ttlMs = typeof body['ttlMs'] === 'number' ? body['ttlMs'] : DEFAULT_HANDOFF_TTL_MS;
    const fromType = scope === 'agent_to_human' || scope === 'agent_to_agent' ? 'agent' : 'user';

    const handoffs = createSqlHandoffManager(db);
    const handoff = await handoffs.request({
      id: newUUIDv7(), runId: run.id, tenantId: run.tenant_id ?? '__global__', scope,
      fromActor: { type: fromType, id: auth.userId }, toActor: { type: 'user', id: toUserId },
      reason, briefing, ttlMs,
      ...(typeof body['parentHandoffId'] === 'string' ? { parentHandoffId: body['parentHandoffId'] } : {}),
      ...(Array.isArray(body['referenceTaskIds']) ? { referenceTaskIds: (body['referenceTaskIds'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
    });
    await notifyHandoff(run.id, run.tenant_id ?? null, toUserId, 'A run was handed to you');
    runExecutor.broadcastEphemeral(run.id, 'handoff.update', { handoff });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handoff }));
  }, { auth: true });

  // List handoffs on a run (+ optional audit per handoff). Requires run access.
  router.get('/api/me/runs/:runId/handoffs', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const handoffs = await createSqlHandoffManager(db).listForRun(access.run.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handoffs }));
  }, { auth: true });

  // The audit trail for one handoff (append-only). Requires run access.
  router.get('/api/me/runs/:runId/handoffs/:id/audit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const mgr = createSqlHandoffManager(db);
    const h = await mgr.get(params['id']!);
    if (!h || h.runId !== access.run.id) { res.writeHead(404); res.end(JSON.stringify({ error: 'Handoff not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ audit: await mgr.audit(params['id']!) }));
  }, { auth: true });

  // My handoff INBOX — handoffs assigned to me (no run access needed; the handoff
  // IS the capability, so a not-yet-accepted recipient can see + act on it).
  router.get('/api/me/handoffs/inbox', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const handoffs = await createSqlHandoffManager(db).listForActor(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handoffs }));
  }, { auth: true });

  // Handoff lifecycle transitions. Authorization is by ACTOR (the port enforces:
  // only the recipient accepts/rejects/starts/hands-back; only the requester
  // cancels; either participant completes/fails). On ACCEPT the recipient is
  // granted collaborator access to the run's shared session — that is "taking
  // over the session". Each transition notifies the other party + broadcasts live.
  for (const action of ['accept', 'reject', 'cancel', 'start', 'hand-back', 'complete', 'fail'] as const) {
    router.post(`/api/me/runs/:runId/handoffs/:id/${action}`, async (req, res, params, auth) => {
      if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      const mgr = createSqlHandoffManager(db);
      const existing = await mgr.get(params['id']!);
      if (!existing || existing.runId !== params['runId']) { res.writeHead(404); res.end(JSON.stringify({ error: 'Handoff not found' })); return; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
      const note = typeof body['note'] === 'string' ? body['note'].slice(0, 1000) : undefined;
      try {
        let updated;
        switch (action) {
          case 'accept': {
            updated = await mgr.accept(existing.id, auth.userId, note);
            // Take over the session: grant the recipient collaborator access.
            const run = await db.getUserRunById(existing.runId);
            if (run) {
              const sessions = createSqlSessionManager(db);
              const session = await sessions.createSession({ id: newUUIDv7(), runId: run.id, tenantId: run.tenant_id ?? '__global__', ownerId: run.user_id });
              await sessions.join(session.id, auth.userId, 'collaborator').catch(() => { /* idempotent */ });
            }
            await notifyHandoff(existing.runId, existing.tenantId === '__global__' ? null : existing.tenantId, existing.fromActor.id, 'Your handoff was accepted');
            break;
          }
          case 'reject': {
            const reason = typeof body['reason'] === 'string' ? body['reason'].slice(0, 1000) : '';
            if (!reason.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'a rejection requires a reason' })); return; }
            updated = await mgr.reject(existing.id, auth.userId, reason);
            await notifyHandoff(existing.runId, existing.tenantId === '__global__' ? null : existing.tenantId, existing.fromActor.id, 'Your handoff was declined');
            break;
          }
          case 'cancel': updated = await mgr.cancel(existing.id, auth.userId, note); break;
          case 'start': updated = await mgr.start(existing.id, auth.userId, note); break;
          case 'hand-back': {
            const back = (body['briefing'] && typeof body['briefing'] === 'object') ? body['briefing'] as HandoffBriefing : undefined;
            updated = await mgr.handBack(existing.id, auth.userId, back, note);
            await notifyHandoff(existing.runId, existing.tenantId === '__global__' ? null : existing.tenantId, existing.fromActor.id, 'A handoff was handed back to you');
            break;
          }
          case 'complete': updated = await mgr.complete(existing.id, auth.userId, note); break;
          case 'fail': {
            const reason = typeof body['reason'] === 'string' ? body['reason'].slice(0, 1000) : 'failed';
            updated = await mgr.fail(existing.id, auth.userId, reason);
            break;
          }
        }
        runExecutor.broadcastEphemeral(existing.runId, 'handoff.update', { handoff: updated });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ handoff: updated }));
      } catch (err) {
        // Illegal transition / forbidden actor → 403 (the port is the source of truth).
        res.writeHead(403); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Forbidden' }));
      }
    }, { auth: true });
  }

  // ── CRDT co-editing (Collaboration Phase 7) ──────────────────────────────────
  // The server is the TRUSTED RELAY: it holds the canonical replica, validates
  // every edit, persists it, and fans it out. A user edits as a server-derived
  // site id (`u:<userId>`) — never a client-supplied one (anti-forgery).

  // Create (idempotently) the co-edit doc for a run + return its current state.
  router.post('/api/me/runs/:runId/coedit', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const repo = createCoeditRepo(db);
    const view = await repo.ensureDoc({ runId: access.run.id, tenantId: access.run.tenant_id ?? null, ownerId: access.run.user_id, ...(typeof body['title'] === 'string' ? { title: (body['title'] as string).slice(0, 200) } : {}) });
    // Mint a UNIQUE device site under this user's namespace, so multiple tabs /
    // devices are distinct CRDT replicas yet every op is provably owned by the user.
    const siteId = `${userSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId }));
  }, { auth: true });

  // Read the current co-edit doc (text + full snapshot + state vector).
  router.get('/api/me/runs/:runId/coedit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const row = await db.getCoeditDocByRun(access.run.id);
    if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'No co-edit doc' })); return; }
    const view = createCoeditRepo(db).view(row);
    const siteId = `${userSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId }));
  }, { auth: true });

  // Submit local ops (a WRITE — collaborator+). Validated (anti-forgery + caps),
  // applied to the canonical replica, persisted, broadcast live as `coedit.op`.
  router.post('/api/me/runs/:runId/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot edit' })); return; }
    const row = await db.getCoeditDocByRun(access.run.id);
    if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'No co-edit doc' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    // The author NAMESPACE is the user's; the op's device-site must live under it.
    const result = await createCoeditRepo(db).submitOps(row.id, userSiteId(auth.userId), body['ops']);
    if (!result.ok) { res.writeHead(result.error.startsWith('forbidden') ? 403 : 400); res.end(JSON.stringify({ error: result.error })); return; }
    if (result.applied.length > 0) runExecutor.broadcastEphemeral(access.run.id, 'coedit.op', { docId: row.id, ops: result.applied });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result.applied.length, text: result.view.text, stateVector: result.view.stateVector }));
  }, { auth: true });

  // Fetch the ops a reconnecting/offline peer is missing (state-vector diff sync).
  // `?since=<base64url(JSON state vector)>`.
  router.get('/api/me/runs/:runId/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const row = await db.getCoeditDocByRun(access.run.id);
    if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'No co-edit doc' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    let since: Record<string, number> = {};
    const raw = url.searchParams.get('since');
    if (raw) { try { since = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, number>; } catch { /* empty = everything */ } }
    const ops = await createCoeditRepo(db).opsSince(row.id, since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ops }));
  }, { auth: true });

  // Broadcast a presence/cursor awareness update (ephemeral — never persisted).
  // Identity (`peerId`) is server-derived so a peer cannot impersonate another.
  router.post('/api/me/runs/:runId/coedit/awareness', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const entry = (body['entry'] && typeof body['entry'] === 'object') ? body['entry'] as Record<string, unknown> : { clock: 0, state: null };
    runExecutor.broadcastEphemeral(access.run.id, 'coedit.awareness', { peerId: userSiteId(auth.userId), entry });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  // Stream the run's agent output INTO the doc as the agent peer (idempotent).
  // Owner/collaborator — the agent co-edits alongside humans.
  router.post('/api/me/runs/:runId/coedit/agent-sync', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const row = await db.getCoeditDocByRun(access.run.id);
    if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'No co-edit doc' })); return; }
    // The agent's contribution is the run's assistant text output.
    const events = await db.listUserRunEvents(access.run.id);
    let fullText = '';
    for (const ev of events) { if (ev.kind === 'text.delta') { try { const p = JSON.parse(ev.payload) as { delta?: unknown }; if (typeof p.delta === 'string') fullText += p.delta; } catch { /* */ } } }
    const result = await createCoeditRepo(db).agentAppend(row.id, access.run.id, fullText);
    if (result && result.applied.length > 0) runExecutor.broadcastEphemeral(access.run.id, 'coedit.op', { docId: row.id, ops: result.applied });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result?.applied.length ?? 0, text: result?.view.text ?? '' }));
  }, { auth: true });

  // ─── Catalog ────────────────────────────────────────────────────────────

  router.get('/api/me/catalog', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const surfaceId = url.searchParams.get('surface') ?? 'web';
    const ctx = weaveContext({
      userId: auth.userId,
      ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
      metadata: { persona: auth.persona },
    });
    const [catalog, starters] = await Promise.all([
      catalogResolver.resolve(ctx, { surfaceId }),
      db.listStarterPrompts(surfaceId),
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      surfaceId: catalog.surfaceId,
      resolvedAt: catalog.resolvedAt,
      entries: catalog.entries,
      starterPrompts: starters.map((s) => ({
        id: s.id,
        label: s.label,
        promptText: s.prompt_text,
      })),
    }));
  }, { auth: true });

  // ─── Theme ──────────────────────────────────────────────────────────────
  // Per-tenant design tokens (colors / font families / radii) for the caller's
  // tenant. Fail-soft: any error degrades to `{ theme: null }` so the client
  // renders the base brand theme. WCAG-AA enforcement happens client-side.

  router.get('/api/me/theme', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let theme = null;
    try {
      theme = await resolveTenantThemeTokens(db, auth.tenantId ?? null);
    } catch {
      theme = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ theme }));
  }, { auth: true });

  // ─── Tasks ──────────────────────────────────────────────────────────────

  router.get('/api/me/tasks', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const tasks = await taskRepo.listByAssignee(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  }, { auth: true });

  router.post('/api/me/tasks', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    // `actionable` marks a task that requires an explicit approve/deny decision
    // (an "approval") versus a plain to-do ("action item"). It is persisted on
    // the task so the Approvals vs Action-items split is grounded in real data,
    // not a client-side heuristic.
    const actionable = body['actionable'] === true;
    const task = createActionItem({
      assignee: auth.userId,
      title: String(body['title'] ?? 'Untitled task'),
      description: typeof body['description'] === 'string' ? body['description'] : undefined,
      dueAt: typeof body['dueAt'] === 'string' ? body['dueAt'] : undefined,
      data: { actionable },
      provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
        ? body['provenance'] as { sourceRunId?: string; sourceRef?: string; createdBy: 'agent'|'principal'|'system' }
        : { sourceRef: 'api', createdBy: 'principal' as const },
    });
    await taskRepo.save(task);
    if (notifications) {
      void notifications.notifyTask(
        { id: task.id, assignee: task.assignee, title: task.title, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) },
        { actionable },
      ).catch(() => {});
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  }, { auth: true });

  router.post('/api/me/tasks/:taskId/complete', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    try {
      const task = await completeActionItem(params['taskId']!, { repository: taskRepo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  router.post('/api/me/tasks/:taskId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    try {
      const task = await cancelActionItem(params['taskId']!, { repository: taskRepo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  // ─── Notification actions ─────────────────────────────────────────────────

  router.post('/api/me/notifications/actions', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : '';
    const actionId = typeof body['actionId'] === 'string' ? body['actionId'] : '';
    if (!taskId || !['approve', 'deny'].includes(actionId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'taskId and actionId (approve|deny) are required' })); return;
    }
    const task = await taskRepo.get(taskId);
    // Hide cross-principal tasks behind a 404 (no existence disclosure).
    if (!task || task.assignee !== auth.userId) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
    }
    // Idempotent: a task already in a terminal state returns the prior outcome.
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alreadyResolved: true, status: task.status }));
      return;
    }
    const resolved = actionId === 'approve'
      ? await completeActionItem(taskId, { repository: taskRepo })
      : await cancelActionItem(taskId, { repository: taskRepo });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resolved: true, status: resolved.status }));
  }, { auth: true, csrf: true });

  // ─── Reminders ──────────────────────────────────────────────────────────

  router.get('/api/me/reminders', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Merge trigger-store reminders (created via POST /api/me/reminders) with
    // temporal reminders the agent wrote via temporal tools. Both paths are
    // valid; the trigger-store set is keyed by id so DB rows with the same id
    // are deduplicated.
    const [storeReminders, temporalRows] = await Promise.all([
      triggerStore.listByOwner(auth.userId),
      db.listTemporalRemindersByUserId(auth.userId),
    ]);
    const seenIds = new Set(storeReminders.map((r) => r.id));
    const temporalAsReminders = temporalRows
      .filter((row) => !seenIds.has(row.id))
      .map((row) => ({
        id: row.id,
        key: row.id,
        enabled: row.status === 'scheduled',
        ownerPrincipalId: row.scope_id.split(':')[0],
        source: { kind: 'schedule', config: { fireAt: row.due_at, timezone: row.timezone } },
        target: { kind: 'reminder_bus', config: { label: row.text } },
        metadata: { oneShot: true, label: row.text },
      }));
    const reminders = [...storeReminders, ...temporalAsReminders];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reminders }));
  }, { auth: true });

  router.post('/api/me/reminders', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    let reminder;
    try {
      reminder = createReminderTrigger({
        ownerPrincipalId: auth.userId,
        label: String(body['label'] ?? 'Reminder'),
        ...(typeof body['fireAt'] === 'string' ? { fireAt: body['fireAt'] } : {}),
        ...(typeof body['rrule'] === 'string' ? { rrule: body['rrule'] } : {}),
        provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
          ? body['provenance'] as { sourceRunId?: string; sourceRef?: string }
          : undefined,
      });
    } catch (err) {
      res.writeHead(400); res.end(JSON.stringify({ error: String(err) })); return;
    }
    await triggerStore.save(reminder);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reminder));
  }, { auth: true });

  router.post('/api/me/reminders/:reminderId/reschedule', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (typeof body['fireAt'] !== 'string') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'fireAt is required' })); return;
    }
    try {
      const updated = await rescheduleReminder(params['reminderId']!, body['fireAt'], triggerStore);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  router.del('/api/me/reminders/:reminderId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const reminderId = params['reminderId']!;
    // Try trigger store first (reminders created via POST /api/me/reminders).
    const storeReminder = await triggerStore.get(reminderId);
    if (storeReminder) {
      if (storeReminder.ownerPrincipalId !== auth.userId) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
      }
      await triggerStore.delete?.(reminderId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    // Fall back to temporal_reminders (agent-created via temporal tools).
    const deleted = await db.deleteTemporalReminderById(reminderId, auth.userId);
    if (!deleted) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ─── Devices ────────────────────────────────────────────────────────────

  router.post('/api/me/devices', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const channel = body['channel'];
    if (!['web-push', 'apns', 'fcm'].includes(String(channel))) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid channel' })); return;
    }
    const token = String(body['token'] ?? '');
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'token required' })); return; }
    await db.registerDevice({
      id: newUUIDv7(),
      user_id: auth.userId,
      channel: channel as 'web-push' | 'apns' | 'fcm',
      token,
      ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ registered: true }));
  }, { auth: true });

  router.del('/api/me/devices/:token', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const token = decodeURIComponent(params['token']!);
    await db.removeDevice(auth.userId, token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed: true }));
  }, { auth: true });

  // ─── Notification preferences ────────────────────────────────────────────

  router.get('/api/me/notification-preferences', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const prefs = await db.getNotificationPrefs(auth.userId);
    if (!prefs) {
      // Return defaults when no preferences have been set yet
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, categories: [], quietHours: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: prefs.enabled === 1,
      categories: prefs.categories ? ((): string[] => { try { return JSON.parse(prefs.categories) as string[]; } catch { return []; } })() : [],
      quietHours: prefs.quiet_hours ?? null,
    }));
  }, { auth: true });

  router.put('/api/me/notification-preferences', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const existing = await db.getNotificationPrefs(auth.userId);
    await db.upsertNotificationPrefs(auth.userId, {
      id: existing?.id ?? newUUIDv7(),
      enabled: body['enabled'] !== false,
      categories: Array.isArray(body['categories']) ? body['categories'] as string[] : [],
      quiet_hours: typeof body['quietHours'] === 'string' ? body['quietHours'] : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saved: true }));
  }, { auth: true });
}
