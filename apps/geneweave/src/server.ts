// SPDX-License-Identifier: MIT
/**
 * @weaveintel/geneweave — HTTP server + routes
 *
 * Zero-dependency HTTP server built on node:http with a hand-rolled router,
 * JSON body parsing, cookie handling, CORS, auth middleware, and SSE support.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { newUUIDv7, createLogger } from '@weaveintel/core';

const logger = createLogger('geneweave-server');
import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './db.js';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqliteA2ATaskStore } from '@weaveintel/a2a';
import type { ChatEngine } from './chat.js';
import { createModelTextGenerator } from './note-ai-sql.js';
import { createModelImageGenerator, createModelVisionVerifier } from './note-creative-sql.js';
import type { VoiceEngine } from './voice-engine.js';
import { DashboardService } from './dashboard.js';
import { SPA_HTML, STYLES_CSP_HASH, SCRIPT_CSP_HASHES } from './ui-server.js';
import { getDocsHTML } from './docs-html.js';
import { authenticateRequest, verifyCSRF } from './auth.js';
import { createNotificationsHub } from './notifications-wiring.js';
import { MeRunExecutor } from './me-run-executor.js';
import { startPresenceSweeper } from './presence-sql.js';
import { createNotificationRelay, enqueueRunTerminalNotifications } from './run-notifications-outbox.js';
import { startHandoffSweeper } from './handoff-sql.js';
import { createCoeditRepo } from './coedit-sql.js';
import { matchRunControlPath, isAllowedWsOrigin, handleRunControlConnection, MAX_CONTROL_MESSAGE_BYTES } from './run-control-ws.js';
import { createChatPipelineMeRunAgent } from './me-run-agent.js';
import { type TriggerDispatcherHandle } from './admin/api/triggers.js';
import { type LoadedGatewayConfig } from './mcp-gateway.js';
import { type OAuthProviderName } from '@weaveintel/identity/oauth';
import { createHealthChecker, createIdempotencyStore } from '@weaveintel/resilience';
import {
  Router,
  json,
  html,
  readClientIp,
  initHttpRateLimiter,
  initLoginFailureStore,
  checkEdgeRateLimit,
  SERVER_REQUEST_TIMEOUT_MS,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_MAX_HEADERS_COUNT,
  SERVER_MAX_REQUESTS_PER_SOCKET,
} from './server-core.js';
import { createHttpRateLimiter, createLoginFailureStore } from './http-rate-limiter.js';
import { createDurableConsentManager } from '@weaveintel/guardrails/compliance';
import {
  registerAuthRoutes,
  registerModelRoutes,
  registerSettingsRoutes,
  registerTraceRoutes,
  registerChatRoutes,
  registerAdminWiringRoutes,
  registerA2ARoutes,
  registerMemoryRoutes,
  registerLiveAgentRoutes,
  registerAdminLiveRunStreamRoute,
  registerMeRoutes,
  registerMeConversationsRoutes,
  registerMeMemoryRoutes,
  registerMeAgendaRoutes,
  registerMeAccountRoutes,
  registerMeFeedbackRoutes,
  registerMeCitationsRoutes,
  registerMeVersionsRoutes,
  registerMeI18nRoutes,
  registerMeSuggestedPromptsRoutes,
  registerMeAccessibilityRoutes,
  registerMeWorkspaceRoutes,
  registerMeNotesRoutes,
  registerMeComplianceRoutes,
  registerVoiceRoutes,
  registerArtifactRoutes,
  registerShareRoutes,
  registerRunShareRoutes,
} from './routes/index.js';

export interface ServerConfig {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  /** Voice agent engine — undefined when OpenAI key is not configured */
  voiceEngine?: VoiceEngine;
  jwtSecret: string;
  corsOrigin?: string;
  providers?: Record<string, { apiKey?: string }>;
  publicBaseUrl?: string;
  /**
   * Phase 4: snapshot of the gateway's exposure config loaded from the
   * `tool_catalog` row at startup. When omitted, code-level defaults are
   * used (for tests or embedded callers that have not seeded the catalog).
   */
  gatewayConfig?: LoadedGatewayConfig;
  /** App-wide runtime — threaded into admin routes so weaveAudit writes to durable KV. */
  runtime?: import('@weaveintel/core').WeaveRuntime;
  /**
   * Workflow Platform Phase 1: optional handle to the singleton
   * `DefaultWorkflowEngine` constructed at startup. When supplied, the
   * `POST /api/admin/workflows/:id/run` route uses it to start runs
   * against `workflow_defs`. When omitted (e.g. test boot) that route
   * returns 503 to make the missing wiring obvious.
   */
  workflowEngine?: import('./workflow-engine.js').WorkflowEngineHandle;
  /**
   * Phase 3 Unified Triggers: optional handle to the singleton
   * `TriggerDispatcher` plus its in-process `ManualSourceAdapter`.
   * When omitted, the trigger admin routes still serve CRUD against
   * `triggers`/`trigger_invocations` but the manual-fire route returns
   * 503 because there is no live dispatcher to route through.
   */
  triggerDispatcher?: TriggerDispatcherHandle;
}

export function createGeneWeaveServer(config: ServerConfig): Server {
  const { db, chatEngine, voiceEngine, jwtSecret, corsOrigin, providers, publicBaseUrl, gatewayConfig, workflowEngine, triggerDispatcher } = config;
  const dashboard = new DashboardService(db);
  const router = new Router();
  const uiHtml = SPA_HTML;
  const docsHtml = getDocsHTML();

  // Idempotency store for write endpoints. Keyed by `userId:idempotency-key`.
  // TTL of 24 hours matches typical payment-processor expectations; max 10k
  // entries prevents unbounded memory growth on a single instance.
  const idempotencyStore = createIdempotencyStore({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 10_000 });

  // Initialize rate limiters — Redis when REDIS_URL is set, in-process otherwise.
  // Fire-and-forget: lazy fallbacks in server-core handle early requests.
  void createHttpRateLimiter(process.env['REDIS_URL']).then(initHttpRateLimiter);
  void createLoginFailureStore(process.env['REDIS_URL']).then(initLoginFailureStore);

  // POST routes where idempotency is meaningful (state-mutating, non-streaming).
  // Paths are matched as prefix strings so parameterised variants are covered.
  const IDEMPOTENT_POST_PREFIXES = new Set([
    '/api/me/agenda',
    '/api/me/notes',
    '/api/chat',
    '/api/me/conversations',
    '/api/voice/sessions',
    '/api/me/memories',
  ]);

  // Readiness probe — checks that all critical subsystems are operational before
  // accepting traffic. Used by k8s readinessProbe / ECS health checks.
  const healthChecker = createHealthChecker('geneweave');
  healthChecker.addCheck('database', async () => {
    try {
      await db.getUserById('__healthcheck__');
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // getUserById throwing for an unknown id is expected and means DB is up.
      // Any other error indicates a connectivity problem.
      if (msg.includes('not found') || msg.includes('undefined') || msg === '') {
        return { ok: true };
      }
      return { ok: false, message: msg };
    }
  });

  async function setOAuthState(state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }): Promise<void> {
    await db.createOAuthFlowState({
      id: newUUIDv7(),
      state_key: state,
      user_id: value.userId,
      provider: value.provider,
      expires_at: new Date(value.expiresAt).toISOString(),
    });
  }

  async function consumeOAuthState(state: string): Promise<{ userId: string | null; provider: OAuthProviderName; expiresAt: number } | null> {
    const found = await db.consumeOAuthFlowStateByKey(state);
    if (!found) return null;
    return {
      userId: found.user_id,
      provider: found.provider as OAuthProviderName,
      expiresAt: Date.parse(found.expires_at),
    };
  }

  const oauthStateCleanupTimer = setInterval(() => {
    void db.deleteExpiredOAuthFlowStates().catch(() => {
      // Best effort cleanup only.
    });
  }, 60_000);
  oauthStateCleanupTimer.unref?.();

  // ── WS ticket store (L-6) ──────────────────────────────────
  // Short-lived opaque tokens used to authenticate WebSocket upgrades without
  // embedding a full JWT in the query string (where it appears in server logs
  // and browser history). Each ticket is 32 random bytes (256-bit), one-time-
  // use, and expires after 60 seconds.
  interface WsTicket {
    readonly userId: string;
    readonly sessionId: string;
    readonly expiresAt: number;
  }
  const wsTickets = new Map<string, WsTicket>();
  const WS_TICKET_TTL_MS = 60_000;

  /** Issue a new WS ticket for an authenticated user. */
  function issueWsTicket(userId: string, sessionId: string): string {
    const ticket = randomBytes(32).toString('hex');
    wsTickets.set(ticket, { userId, sessionId, expiresAt: Date.now() + WS_TICKET_TTL_MS });
    return ticket;
  }

  /** Consume a WS ticket — returns the associated auth info or null if invalid/expired. */
  function consumeWsTicket(ticket: string): WsTicket | null {
    const entry = wsTickets.get(ticket);
    wsTickets.delete(ticket); // one-time use regardless of validity
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  // Periodic cleanup of expired tickets (they're consumed on use, but leaked tickets
  // that were never presented accumulate without this cleanup).
  const wsTicketCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of wsTickets) {
      if (now > v.expiresAt) wsTickets.delete(k);
    }
  }, 30_000);
  wsTicketCleanupTimer.unref?.();

  // ── Route registration ─────────────────────────────────────

  registerAuthRoutes(router, db, { jwtSecret, corsOrigin, publicBaseUrl, setOAuthState, consumeOAuthState });
  registerModelRoutes(router, db, chatEngine, providers);
  registerSettingsRoutes(router, db);
  registerTraceRoutes(router, db, dashboard);
  registerChatRoutes(router, db, chatEngine, dashboard, workflowEngine as { getStatus?: () => unknown } | undefined);
  registerAdminWiringRoutes(router, db, { providers, publicBaseUrl, gatewayConfig, workflowEngine, triggerDispatcher, chatEngine, runtime: config.runtime });
  const a2aTaskStore = db instanceof SQLiteAdapter ? createSqliteA2ATaskStore(db.rawDb) : undefined;
  registerA2ARoutes(router, db, chatEngine, { baseUrl: publicBaseUrl ?? 'http://localhost:3000', taskStore: a2aTaskStore });
  registerMemoryRoutes(router, db);
  registerLiveAgentRoutes(router, db);
  registerAdminLiveRunStreamRoute(router, db);
  // Collaboration Phase 3: the durable notification relay (transactional outbox
  // → in-app feed + signed webhooks). Crash-safe and restart-safe.
  const notificationRelay = createNotificationRelay({ db });
  const meRunExecutor = new MeRunExecutor({
    db,
    runAgent: createChatPipelineMeRunAgent(chatEngine, db),
    // On terminal: enqueue one outbox row per subscriber, then nudge the relay
    // to drain immediately (it also drains on its own interval). Fire-and-forget.
    onTerminal: (runId) => {
      void (async () => {
        const run = await db.getUserRunById(runId);
        if (run) await enqueueRunTerminalNotifications(db, run);
        await notificationRelay.drainOnce();
        // Collaboration Phase 7: if the run has a co-edit doc, merge the agent's
        // final output into it as the agent peer (idempotent) + broadcast live.
        const coeditRow = await db.getCoeditDocByRun(runId).catch(() => null);
        if (coeditRow) {
          const events = await db.listUserRunEvents(runId).catch(() => []);
          let fullText = '';
          for (const ev of events) { if (ev.kind === 'text.delta') { try { const p = JSON.parse(ev.payload) as { delta?: unknown }; if (typeof p.delta === 'string') fullText += p.delta; } catch { /* */ } } }
          const result = await createCoeditRepo(db).agentAppend(coeditRow.id, runId, fullText).catch(() => null);
          if (result && result.applied.length > 0) meRunExecutor.broadcastEphemeral(runId, 'coedit.op', { docId: coeditRow.id, ops: result.applied });
        }
      })().catch(() => { /* best-effort */ });
    },
  });
  registerMeRoutes(router, db, {
    notifications: createNotificationsHub({ db }),
    runExecutor: meRunExecutor,
    notificationRelay,
  });
  // Collaboration Phase 1: start the presence TTL sweeper (reaps participants
  // who stopped heartbeating, e.g. closed a tab without a clean leave, and
  // re-broadcasts the updated "who's watching" snapshot).
  startPresenceSweeper(db, meRunExecutor);
  // Collaboration Phase 3: start the relay loop and run a one-shot reconcile so
  // any notification owed before a restart (run finished while the process was
  // down, or a crash between terminal + enqueue) is delivered on boot.
  notificationRelay.start();
  void notificationRelay.reconcile();
  // Collaboration Phase 5: SLA sweeper — time out overdue handoffs so an
  // unbounded human wait never deadlocks a run; broadcast each timeout live.
  startHandoffSweeper(db, (runId, kind, payload) => meRunExecutor.broadcastEphemeral(runId, kind, payload));
  registerMeConversationsRoutes(router, db);
  // M5-3: pass consent manager so isGranted() is called on every memory write path.
  registerMeMemoryRoutes(router, db, { consentManager: config.runtime ? createDurableConsentManager({ runtime: config.runtime, namespace: 'consent' }) : undefined });
  registerMeAgendaRoutes(router, db);
  registerMeAccountRoutes(router, db);
  registerMeFeedbackRoutes(router, db);
  // m138: answer citations in chat — grounded answers over the user's own workspace with verified [n]
  // sources. Reuses the notes "Ask your workspace" engine, so it needs the same LLM text generator.
  registerMeCitationsRoutes(router, db, { aiGenerate: createModelTextGenerator(chatEngine.modelConfig) });
  // m139: regenerate an answer, keeping version history — needs an LLM to produce the alternative.
  registerMeVersionsRoutes(router, db, { aiGenerate: createModelTextGenerator(chatEngine.modelConfig) });
  // m140: per-tenant accessibility defaults (streaming announcements + reduced motion) for the client.
  registerMeAccessibilityRoutes(router, db);
  // m143: workspace roles — which UI areas this user sees (surface parity) + member role management.
  registerMeWorkspaceRoutes(router, db);
  // m145: internationalisation — the effective UI message pack for the reader's language.
  registerMeI18nRoutes(router, db);
  // m146: suggested/starter prompts — the empty-chat conversation starters (curated + personalised).
  registerMeSuggestedPromptsRoutes(router, db);
  // weaveNotes Phase 3: give the notes routes an LLM generator (built from the chat
  // engine's resolved providers + default model) so the AI co-author actions work.
  // weaveNotes Phase 4: pass the share-token secret + public base url so a note can be
  // published as a shareable artifact.
  registerMeNotesRoutes(router, db, {
    aiGenerate: createModelTextGenerator(chatEngine.modelConfig),
    imageGenerate: createModelImageGenerator(chatEngine.modelConfig),
    verifyVision: createModelVisionVerifier(chatEngine.modelConfig),
    // weaveNotes Phase 4: detailed (segmented) speech-to-text via the voice engine's audio model.
    ...(voiceEngine ? { transcribe: (a: { audio: Buffer; mimeType?: string; language?: string; model?: string }) => voiceEngine.transcribeDetailed(a) } : {}),
    jwtSecret,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    // Run a note action through the geneWeave SUPERVISOR, which DELEGATES to the weaveNotes Editor
    // worker agent — the worker calls the create_diagram / restructure_note / … tool (its callbacks
    // are wired into the worker's registry) → stages a suggestion. We give the supervisor ONLY the
    // weaveNotes Editor worker (workersOverride) and NO direct note tools (toolsOverride: []), so it
    // must hand the work to the specialist rather than calling the tool itself. Uses an ephemeral
    // chat that is deleted afterwards so the user's chat history stays clean.
    runNoteAgentAction: async ({ userId, noteId, instruction, mode }) => {
      const chatId = `note-agent-${noteId.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}`;
      // In SUPERVISOR mode, give the supervisor ONLY the weaveNotes Editor worker (from the seeded
      // worker_agents row) and NO direct note tools, so it MUST delegate to the specialist. In AGENT
      // mode the single chat agent calls the note tool itself (the tools are force-registered).
      let overrides: { workersOverride?: import('./chat-runtime.js').WorkerDef[]; toolsOverride?: string[] } = {};
      if (mode === 'supervisor') {
        try {
          const editor = (await db.listEnabledWorkerAgents()).find((w) => w.name === 'weavenotes_editor');
          if (editor) {
            let tools: string[]; try { tools = JSON.parse(editor.tool_names ?? '[]') as string[]; } catch { tools = []; }
            overrides = { workersOverride: [{ name: editor.name, description: editor.description ?? 'Co-authors the user’s notes.', tools, persona: editor.persona ?? 'agent_worker' }], toolsOverride: [] };
          }
        } catch { /* fall back to default supervisor topology */ }
      }
      try {
        await db.createChat({ id: chatId, userId, title: 'weaveNotes assistant', model: chatEngine.modelConfig.defaultModel, provider: chatEngine.modelConfig.defaultProvider });
        const r = await chatEngine.sendMessage(userId, chatId, instruction, { modeOverride: mode, ...overrides });
        return { ok: Boolean(r.assistantContent?.trim()), content: r.assistantContent };
      } finally {
        try { await db.deleteChat(chatId, userId); } catch { /* best-effort cleanup */ }
      }
    },
  });
  registerMeComplianceRoutes(router, db, config.runtime);
  registerArtifactRoutes(router, db, { jwtSecret, publicBaseUrl });
  registerShareRoutes(router, db, { jwtSecret });
  // Collaboration Phase 4: public, read-only, redacted run-review share links.
  registerRunShareRoutes(router, db);

  // Voice agent routes — registered only when audio provider is configured
  if (voiceEngine) {
    registerVoiceRoutes(router, db, voiceEngine);
  }

  // L-6: WS ticket endpoint — issues a short-lived opaque ticket that the WS
  // client presents in the query string (?ticket=...) instead of a full JWT.
  // This keeps the JWT out of server access logs and browser history entries.
  // The ticket is one-time-use and expires in 60 seconds.
  router.post('/api/ws-ticket', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const ticket = issueWsTicket(auth.userId, auth.sessionId);
    json(res, 200, { ticket, expiresInMs: WS_TICKET_TTL_MS });
  });

  // ── Avatar static files ────────────────────────────────────

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const avatarDirs = [
    join(__dirname, '..', 'avatar'),
    join(__dirname, '..', 'avatars'),
    join(process.cwd(), 'packages', 'geneweave', 'avatar'),
    join(process.cwd(), 'packages', 'geneweave', 'avatars'),
    join(process.cwd(), 'avatar'),
    join(process.cwd(), 'avatars'),
  ];
  // API dist (for any API-owned static files)
  const distDir = join(__dirname, '..', 'dist');
  const distDirResolved = resolve(distDir);
  // UI dist — geneweave-ui is a sibling workspace package; its compiled output
  // is served for all /ui.js, /ui/*, and /features/* paths.
  // Resolution order: workspace sibling → node_modules symlink → API dist (fallback).
  const uiDistDir = (() => {
    const candidates = [
      // Monorepo workspace sibling (dev with tsx or after tsc -b)
      resolve(join(__dirname, '..', '..', 'geneweave-ui', 'dist')),
      // npm install creates a symlink in node_modules
      resolve(join(__dirname, '..', 'node_modules', '@weaveintel', 'geneweave-ui', 'dist')),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // Fallback: old monolithic dist (works before first split build or for existing deployments)
    return distDirResolved;
  })();
  const staticModuleExtensions = new Set(['.js', '.css', '.map']);

  // ── HTTP server ────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // M-1: CORS — strip CRLF from the origin before reflecting it into a header
    // (CRLF in header values enables HTTP response splitting / header injection).
    // Never send `Access-Control-Allow-Credentials: true` with a wildcard origin
    // (`*`) — browsers reject it and it indicates a misconfiguration; instead
    // silently drop the Credentials header when the operator sets corsOrigin='*'.
    // F002: Security hardening headers on every response.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS — only meaningful when the connection is already TLS. In production
    // the ingress (nginx / CloudFront / ALB) terminates TLS and sets this header
    // for the public-facing connection; setting it here also covers direct-TLS
    // deployments. max-age=31536000 (1 year) is the recommended value for preload.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // CSP — H2: use sha256 hashes for inline <style> and <script> blocks instead
    // of 'unsafe-inline'. Hashes are computed once at server startup from the
    // exact byte content embedded in SPA_HTML (see ui-server.ts).
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // SHA-256 hashes for the two inline <script> blocks (admin schema + ESM bootstrap).
        // cdn.sheetjs.com serves xlsx for admin data export.
        `script-src 'self' ${SCRIPT_CSP_HASHES.join(' ')} https://cdn.sheetjs.com`,
        // SHA-256 hash for the inline <style> block; fonts.googleapis.com serves font CSS.
        `style-src 'self' ${STYLES_CSP_HASH} https://fonts.googleapis.com`,
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
      ].join('; '),
    );

    if (corsOrigin) {
      // Remove CR/LF characters that could inject extra headers.
      const safeOrigin = corsOrigin.replace(/[\r\n]/g, '');
      res.setHeader('Access-Control-Allow-Origin', safeOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
      // Credentials + wildcard is a browser-rejected combination and a security
      // red flag.  Only emit the Credentials header for explicit single-origin configs.
      if (safeOrigin !== '*') {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Global edge rate limit — 600 req/min per IP (configurable via GENEWEAVE_EDGE_IP_LIMIT).
    // Fails open if the rate limiter is unavailable so requests are never blocked by infrastructure.
    const edgeCheck = await checkEdgeRateLimit(req);
    if (edgeCheck.limited) {
      res.setHeader('Retry-After', String(Math.ceil(edgeCheck.retryAfterMs / 1_000)));
      json(res, 429, { error: 'Too many requests' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // Serve UI module files (but NOT admin-schema.js - it's embedded in HTML)
    if ((method === 'GET' || method === 'HEAD') && pathname.match(/^\/(?:ui(?:\/|\.)|features\/)/)) {
      // Map /ui.js to /ui-client.js (client-side only module)
      let filename = pathname.slice(1);
      if (filename === 'ui.js') {
        filename = 'ui-client.js';
      }

      let decodedFilename = filename;
      try {
        decodedFilename = decodeURIComponent(filename);
      } catch {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const hasInvalidSegment = decodedFilename
        .split('/')
        .some((segment) => segment === '..' || segment.includes('\0'));
      if (hasInvalidSegment) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      // UI files are served from geneweave-ui's dist; the security check uses that base.
      const uiDistDirResolved = resolve(uiDistDir);
      const filepath = resolve(uiDistDirResolved, decodedFilename);
      if (!filepath.startsWith(uiDistDirResolved + sep)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const extension = extname(filepath);
      if (!staticModuleExtensions.has(extension)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      try {
        const data = await fsReadFile(filepath);
        const contentType = extension === '.js'
          ? 'application/javascript'
          : extension === '.css'
            ? 'text/css'
            : 'application/json';
        res.writeHead(200, {
          'Content-Type': contentType + '; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        if (method === 'GET') {
          res.end(data);
        } else {
          res.end(); // HEAD request: don't send body
        }
        return;
      } catch (err) {
        json(res, 404, { error: 'Not found' });
        return;
      }
    }

    // ── MCP Gateway pass-through ──
    // The gateway has its own bearer-token auth and the MCP SDK transport
    // reads the body itself, so we bypass the router (which would consume
    // the stream and apply CSRF). The gateway returns 503 when no token is
    // configured, so it is loud-fail rather than silent.
    const mcpGatewayHandle = (router as unknown as { _mcpGateway?: { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> } })._mcpGateway;
    if (pathname === '/api/mcp/gateway' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
      if (mcpGatewayHandle) {
        try {
          await mcpGatewayHandle.handle(req, res);
        } catch (err) {
          logger.error('mcp-gateway handler error', { err });
          if (!res.headersSent) {
            json(res, 500, { error: 'MCP gateway error' });
          }
        }
      } else {
        json(res, 503, { error: 'MCP gateway not configured' });
      }
      return;
    }

    // Idempotency check — honour the `Idempotency-Key` header on POST requests
    // to state-mutating /api/me/* and /api/chat/* routes. A repeated request
    // with the same key returns the cached response without re-executing the
    // handler. The key is scoped to the authenticated user so one user cannot
    // replay another's requests.
    if (method === 'POST') {
      const rawKey = req.headers['idempotency-key'];
      const iKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (iKey && [...IDEMPOTENT_POST_PREFIXES].some((p) => pathname.startsWith(p))) {
        const authForIdempotency = await authenticateRequest(req, db, jwtSecret).catch(() => null);
        if (authForIdempotency) {
          const storeKey = `${authForIdempotency.userId}:${iKey.slice(0, 256)}`;
          const { isDuplicate, previousResult } = idempotencyStore.check(storeKey);
          if (isDuplicate && previousResult !== undefined) {
            const cached = previousResult as { status: number; body: unknown };
            json(res, cached.status, cached.body);
            return;
          }
          // Wrap the handler so we can record the response for future replays.
          // We intercept writeHead to capture the status code.
          const originalWriteHead = res.writeHead.bind(res);
          let capturedStatus = 200;
          res.writeHead = (statusCode: number, ...args: unknown[]) => {
            capturedStatus = statusCode;
            return (originalWriteHead as (...a: unknown[]) => ServerResponse)(statusCode, ...args);
          };
          const originalEnd = res.end.bind(res);
          res.end = (...args: unknown[]) => {
            // Only cache 2xx responses to avoid caching errors
            if (capturedStatus >= 200 && capturedStatus < 300) {
              try {
                const body = args[0] ? JSON.parse(String(args[0])) : null;
                idempotencyStore.record(storeKey, { status: capturedStatus, body });
              } catch { /* non-JSON or empty body — skip caching */ }
            }
            return (originalEnd as (...a: unknown[]) => ServerResponse)(...args);
          };
        }
      }
    }

    // GET /api/openapi.json — machine-readable API contract
    if (method === 'GET' && pathname === '/api/openapi.json') {
      const { buildOpenApiSpec } = await import('./openapi.js');
      json(res, 200, buildOpenApiSpec());
      return;
    }

    // Readiness / liveness probes — must not require auth so orchestrators can poll.
    if (method === 'GET' && pathname === '/healthz') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && pathname === '/readyz') {
      const status = await healthChecker.run();
      json(res, status.healthy ? 200 : 503, status);
      return;
    }

    // API routing
    const matched = router.match(method, pathname);
    if (matched) {
      try {
        // Authenticate
        const auth = await authenticateRequest(req, db, jwtSecret);
        // Check auth requirement
        if (matched.route.requireAuth && !auth) {
          json(res, 401, { error: 'Authentication required' });
          return;
        }

        // Check CSRF for mutating requests
        if (matched.route.requireCSRF && auth && !verifyCSRF(req, auth)) {
          json(res, 403, { error: 'Invalid CSRF token' });
          return;
        }

        await matched.route.handler(req, res, matched.params, auth);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Internal server error';
        const correlationId = newUUIDv7();
        logger.error(`Error handling ${method} ${pathname}`, { correlationId, err });
        if (!res.headersSent) {
          if (msg === 'Request body too large') {
            json(res, 413, { error: 'Request body too large' });
          } else if (msg === 'Too many concurrent request bodies') {
            json(res, 503, { error: 'Server is busy reading other requests. Please retry shortly.' });
          } else if (err instanceof SyntaxError && (msg.toLowerCase().includes('json') || msg.toLowerCase().includes('unexpected token') || msg.toLowerCase().includes('unexpected end'))) {
            json(res, 400, { error: 'Invalid JSON in request body' });
          } else {
            json(res, 500, { error: 'Internal server error', correlationId });
          }
        }
      }
      return;
    }

    // Serve avatar images
    const avatarMatch = pathname.match(/^\/avatar\/(avatar-\d+\.webp)$/);
    if (method === 'GET' && avatarMatch) {
      const filename = avatarMatch[1]!;
      let data: Buffer | null = null;
      for (const dir of avatarDirs) {
        try {
          data = await fsReadFile(join(dir, filename));
          break;
        } catch {
          // Try next candidate directory.
        }
      }
      if (data) {
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(data);
      } else {
        json(res, 404, { error: 'Avatar not found' });
      }
      return;
    }

    // Developer documentation — served from apps/geneweave/docs/weaveintel-docs.html
    // when present (operator-authored), with a fall-back to the generated docsHtml.
    if (method === 'GET' && (pathname === '/docs' || pathname === '/docs/')) {
      const staticDocsPath = join(__dirname, '..', 'docs', 'weaveintel-docs.html');
      try {
        const body = await fsReadFile(staticDocsPath, 'utf8');
        html(res, 200, body);
      } catch {
        html(res, 200, docsHtml);
      }
      return;
    }

    // Explicitly block common sensitive probe paths — return 404 so scanners
    // and attackers get no signal about whether these files/endpoints exist.
    // These never match legitimate app routes; blocking them here prevents the
    // SPA catch-all from responding with 200 HTML (which scanners misread as
    // "exposed data"). F005–F021 from the pentest were all SPA HTML false-positives
    // caused by this catch-all firing before the explicit 404 below.
    const BLOCKED_PATHS = /^\/?(\.env|\.git|\.gitignore|\.DS_Store|wp-admin|phpmyadmin|actuator)/i;
    if (method === 'GET' && BLOCKED_PATHS.test(pathname)) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    // Unmatched /api/* paths return 404 JSON — never serve the SPA for API routes.
    // This prevents scanners from getting HTTP 200 for probe URLs like /api/config,
    // /api/debug, /api/swagger.json, etc. and classifying them as "exposed endpoints."
    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    // Serve UI for all non-API routes (SPA)
    if (method === 'GET') {
      html(res, 200, uiHtml);
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = SERVER_MAX_HEADERS_COUNT;
  server.maxRequestsPerSocket = SERVER_MAX_REQUESTS_PER_SOCKET;

  // ── WebSocket upgrade — voice sessions + run control channel ───────────────
  //   Voice:        /api/voice/sessions/:sessionId/ws   (gated on voiceEngine)
  //   Run control:  /api/me/runs/:runId/control          (Collaboration Phase 6)
  // One upgrade listener routes by path; `ws` is dynamically imported on demand.
  {
    server.on('upgrade', async (req: IncomingMessage, socket, head: Buffer) => {
      const url = req.url ?? '';
      const controlMatch = matchRunControlPath(url);
      const wsMatch = voiceEngine ? url.match(/^\/api\/voice\/sessions\/([^/?#]+)\/(ws|realtime)/) : null;
      if (!controlMatch && !wsMatch) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      // CSWSH defense (Phase 6): validate Origin against the host for the control
      // channel — a browser cannot forge Origin, so this blocks cross-site hijack.
      if (controlMatch) {
        const allowed = (process.env['GENEWEAVE_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!isAllowedWsOrigin(req.headers.origin, { allowed, host: req.headers.host })) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      const sessionId = wsMatch?.[1] ?? '';

      // L-6: Authenticate via an opaque short-lived ticket (preferred) or a
      // Bearer JWT (legacy fallback for clients not yet updated). The ticket path
      // keeps the JWT out of access logs and browser URL history; a ticket
      // presented via `?ticket=<hex>` is consumed atomically so it cannot be
      // replayed. The legacy `?token=<jwt>` path is still accepted for
      // backward-compatibility but new clients should use the ticket endpoint.
      const qs = new URL(url, 'http://localhost').searchParams;
      const ticketParam = qs.get('ticket');
      const tokenParam = qs.get('token');

      let auth: Awaited<ReturnType<typeof authenticateRequest>> = null;
      if (ticketParam) {
        // Ticket path: consume the ticket and derive auth from the stored userId.
        const ticketData = consumeWsTicket(ticketParam);
        if (!ticketData) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const user = await db.getUserById(ticketData.userId);
        const session = await db.getSession(ticketData.sessionId);
        if (!user || !session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        auth = {
          userId: ticketData.userId,
          email: user.email,
          sessionId: ticketData.sessionId,
          csrfToken: session.csrf_token,
          persona: user.persona,
          tenantId: user.tenant_id,
        };
      } else {
        if (tokenParam) {
          // Legacy JWT-in-query-string path: inject as Authorization header.
          (req.headers as Record<string, string>)['authorization'] = `Bearer ${tokenParam}`;
        }
        auth = await authenticateRequest(req, db, jwtSecret);
      }

      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      try {
        const { WebSocketServer } = await import('ws');
        const wss = new WebSocketServer({ noServer: true, maxPayload: controlMatch ? MAX_CONTROL_MESSAGE_BYTES : undefined });
        const isRealtime = !!url.match(/\/realtime$/);
        wss.handleUpgrade(req, socket, head, async (ws) => {
          try {
            if (controlMatch) {
              // Collaboration Phase 6 — bidirectional run control plane.
              await handleRunControlConnection(ws, controlMatch.runId, { userId: auth.userId, tenantId: auth.tenantId }, { db, runExecutor: meRunExecutor });
            } else if (isRealtime) {
              await voiceEngine!.handleRealtimeWebSocket({ sessionId, userId: auth.userId, ws });
            } else {
              await voiceEngine!.handleWebSocket({ sessionId, userId: auth.userId, ws, req });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`ws session error`, { sessionId, runId: controlMatch?.runId, msg });
          }
        });
      } catch (err) {
        logger.error('ws failed to handle upgrade', { err });
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });
  }

  return server;
}
