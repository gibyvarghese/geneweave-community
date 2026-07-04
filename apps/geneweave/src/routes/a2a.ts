/**
 * geneWeave — A2A (Agent-to-Agent) routes (v1.0, Phase 5+6+7)
 *
 * Phase 7 additions:
 *  - A2A skills are now DB-backed (a2a_skills table, migration m60).
 *    The Agent Card is assembled at request time from enabled DB rows so
 *    admins can add, edit, disable, or reorder skills in the admin UI
 *    without a code deploy.  Scope gates (mode + required_permission) are
 *    also driven from the DB, not from the hardcoded A2A_SKILLS constant.
 *
 * Phase 6 (still applies):
 *  - External A2A tasks route through chatEngine.sendMessage() — identical
 *    pipeline as the geneWeave chat UI (guardrails, skills, memory, tracing).
 *  - Capability scope gate, model override gate, structured task metadata.
 *
 * Capability scopes (stored in a2a_skills.security_scopes, admin-configurable):
 *   a2a:chat         — agent mode (default, any authenticated user)
 *   a2a:supervisor   — supervisor multi-agent mode (requires agents:delegate permission)
 *   a2a:ensemble     — ensemble reasoning mode (requires agents:delegate permission)
 *   a2a:model-select — provider/model override via metadata.model (requires admin)
 *
 * Endpoints:
 *   GET  /.well-known/agent-card.json  — v1.0 Agent Card (public, built from DB)
 *   GET  /.well-known/agent.json       — legacy alias (backward compat)
 *   POST /api/a2a                      — JSON-RPC 2.0 dispatcher (v1.0 primary)
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type {
  A2ATask,
  A2ATaskSendParams,
  AgentCard,
  A2APart,
} from '@weaveintel/core';
import type { ChatAttachment, WorkerDef } from '../chat.js';
import type { A2ASkillRow } from '../db-types/adapter.js';
import {
  createA2ADispatcher,
  createInMemoryA2ATaskStore,
  createInMemoryPushNotificationStore,
  deliverPushNotificationsForTask,
  streamToSse,
  SSE_KEEPALIVE,
} from '@weaveintel/a2a';
import type { A2ATaskStore, A2APushNotificationStore } from '@weaveintel/a2a';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { canPersonaAccess } from '../rbac.js';

const AGENT_VERSION = '1.0.0';

// ─── DB-backed skill helpers ───────────────────────────────────────────────────

type A2AAllowedMode = 'agent' | 'supervisor' | 'ensemble';

/** Converts a DB row to the AgentCard skill shape expected by the A2A spec. */
function rowToAgentSkill(row: A2ASkillRow): AgentCard['skills'][number] {
  const scopes: string[] = JSON.parse(row.security_scopes || '["a2a:chat"]');
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    examples: row.examples ? (JSON.parse(row.examples) as string[]) : undefined,
    inputModes: row.input_modes ? (JSON.parse(row.input_modes) as string[]) : undefined,
    outputModes: row.output_modes ? (JSON.parse(row.output_modes) as string[]) : undefined,
    security: [{ bearer: scopes }],
  } as AgentCard['skills'][number];
}

/**
 * Derives the OAuth2 scope map from enabled DB skill rows.
 * Each unique scope token gets a human-readable description built from the skill names
 * that carry it, so the Agent Card's securitySchemes stays in sync with the DB.
 */
function buildScopeMap(rows: A2ASkillRow[]): Record<string, string> {
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    const scopes: string[] = JSON.parse(row.security_scopes || '["a2a:chat"]');
    for (const scope of scopes) {
      (map[scope] ??= []).push(row.name);
    }
  }
  const descriptions: Record<string, string> = {
    'a2a:chat': 'Run tasks in single-agent mode (default, any authenticated user)',
    'a2a:supervisor': 'Run tasks in supervisor multi-agent orchestration mode',
    'a2a:ensemble': 'Run tasks in ensemble reasoning mode',
    'a2a:model-select': 'Override the default provider/model via metadata.model',
  };
  const result: Record<string, string> = {};
  for (const [scope, skills] of Object.entries(map)) {
    result[scope] = descriptions[scope] ?? `Access skill(s): ${skills.join(', ')}`;
  }
  // Always include model-select so external callers know it exists even if no skill uses it.
  result['a2a:model-select'] ??= descriptions['a2a:model-select']!;
  return result;
}

/**
 * Maps a caller's requested mode to a validated A2A mode given their persona.
 *
 * The permission required for each non-default mode is read from the DB skill row
 * whose `mode` column matches the requested mode.  If no skill row exists for that
 * mode the request falls back to 'agent'.  This makes the scope gate fully DB-driven.
 *
 * Returns the resolved mode plus an optional note when the request was downgraded.
 */
function resolveA2AMode(
  requestedMode: string | undefined,
  callerPersona: string,
  skillRows: A2ASkillRow[],
): { mode: A2AAllowedMode; downgraded?: string } {
  const raw = (requestedMode ?? 'agent').trim().toLowerCase() as A2AAllowedMode;
  if (raw !== 'supervisor' && raw !== 'ensemble') return { mode: 'agent' };

  const matchingSkill = skillRows.find(r => r.mode === raw && r.enabled);
  if (!matchingSkill) {
    return {
      mode: 'agent',
      downgraded: `Mode '${raw}' is not enabled — no active skill found for this mode. Falling back to 'agent'.`,
    };
  }

  const requiredPermission = matchingSkill.required_permission ?? 'agents:delegate';
  if (!canPersonaAccess(callerPersona, requiredPermission)) {
    return {
      mode: 'agent',
      downgraded: `Mode '${raw}' requires '${requiredPermission}' — caller persona '${callerPersona}' is not authorized. Falling back to 'agent'.`,
    };
  }

  return { mode: raw };
}

/**
 * Whether the caller may override the default provider/model.
 * Requires tenant_admin or higher to prevent cost-escalation attacks.
 */
function canOverrideModel(callerPersona: string): boolean {
  return canPersonaAccess(callerPersona, 'admin:tenant:*') ||
    canPersonaAccess(callerPersona, 'platform:*');
}

// ─── Agent Card ────────────────────────────────────────────────────────────────

async function buildAgentCard(db: DatabaseAdapter, baseUrl: string): Promise<AgentCard> {
  const agentUrl = `${baseUrl}/api/a2a`;
  const rows = await db.listEnabledA2ASkills();
  const skills = rows.map(rowToAgentSkill);
  const scopeMap = buildScopeMap(rows);
  return {
    name: 'geneweave',
    description: 'geneWeave — Intelligent AI orchestration assistant powered by weaveIntel',
    version: AGENT_VERSION,
    skills,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: true,
      stateTransitionHistory: true,
    },
    supportedInterfaces: [
      { url: agentUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    defaultInputModes: ['text/plain', 'audio/*', 'image/*', 'application/pdf', 'text/csv'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      oauth2: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: `${baseUrl}/api/auth/token`,
            scopes: scopeMap,
          },
        },
      },
    },
    security: [{ bearer: [] }],
    url: agentUrl,
  };
}

/**
 * Converts A2A message parts into chat-engine inputs.
 *
 * - TextPart (text) → joined into the user content string
 * - DataPart (data) → JSON-serialised and appended to user content
 * - FilePart/url → noted in user content as a reference (agent cannot fetch arbitrary URLs)
 * - FilePart/raw (base64) → converted to ChatAttachment; audio with a transcript in
 *   part.metadata.transcript is surfaced as transcript-only (raw bytes are stripped by
 *   normalizeAttachments anyway); audio without transcript gets a placeholder text note
 *
 * For real-time bidirectional voice the client should use /api/voice/sessions WebSocket,
 * not the A2A HTTP endpoint.  A2A is appropriate for pre-recorded audio files sent with
 * a transcript or for text/image/CSV tasks.
 */
function extractPartsContent(parts: ReadonlyArray<A2APart>): { text: string; attachments: ChatAttachment[] } {
  const textParts: string[] = [];
  const attachments: ChatAttachment[] = [];

  for (const p of parts) {
    if (typeof p.text === 'string' && p.text) {
      textParts.push(p.text);
    } else if (p.data !== undefined) {
      textParts.push(JSON.stringify(p.data));
    } else if (typeof p.raw === 'string' && p.raw) {
      const mimeType = p.mediaType ?? 'application/octet-stream';
      const filename = p.filename ?? `attachment-${Date.now()}`;
      const isAudio = mimeType.toLowerCase().startsWith('audio/');
      // Approximate decoded size (base64 overhead is ~4/3)
      const size = Math.max(1, Math.floor((p.raw.length * 3) / 4));

      if (isAudio) {
        // Audio bytes are not sent to the LLM; if the caller included a transcript
        // in part.metadata.transcript we pass it through as a voice context attachment.
        const transcript = typeof p.metadata?.['transcript'] === 'string'
          ? (p.metadata['transcript'] as string).trim()
          : undefined;
        if (transcript) {
          attachments.push({ name: filename, mimeType, size, transcript });
        } else {
          textParts.push(
            `[Audio attachment: ${filename} (${mimeType}) — ` +
            `include a "transcript" key in part.metadata for voice processing, ` +
            `or use /api/voice/sessions for real-time voice interaction]`,
          );
        }
      } else {
        // Image, PDF, CSV, etc. — forward as binary attachment; normalizeAttachments
        // handles size limits and sanitizes the base64 string.
        attachments.push({ name: filename, mimeType, size, dataBase64: p.raw });
      }
    } else if (typeof p.url === 'string') {
      // Remote file reference: note in text. The agent may be able to use web tools to
      // fetch publicly accessible URLs, but we cannot do so here at the protocol layer.
      textParts.push(`[File reference: ${p.filename ?? p.url} — ${p.url}]`);
    }
  }

  return {
    text: textParts.filter(Boolean).join('\n'),
    attachments,
  };
}

export function registerA2ARoutes(
  router: Router,
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  options?: { baseUrl?: string; taskStore?: A2ATaskStore },
): void {
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000';

  router.get('/.well-known/agent-card.json', async (_req, res) => {
    json(res, 200, await buildAgentCard(db, baseUrl));
  });

  router.get('/.well-known/agent.json', async (_req, res) => {
    json(res, 200, await buildAgentCard(db, baseUrl));
  });

  const taskStore: A2ATaskStore = options?.taskStore ?? createInMemoryA2ATaskStore();
  const pushStore: A2APushNotificationStore = createInMemoryPushNotificationStore();

  let _dispatcher: ReturnType<typeof createA2ADispatcher> | null = null;
  function getDispatcher() {
    if (_dispatcher) return _dispatcher;
    const a2aImpl = buildGeneWeaveA2AServer(db, chatEngine, taskStore, pushStore);
    _dispatcher = createA2ADispatcher(a2aImpl, taskStore, pushStore);
    return _dispatcher;
  }

  router.post('/api/a2a', async (req, res, _params, auth) => {
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bearer token required' } }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read request body' } }));
      return;
    }

    // Thread the caller's persona through ctx so the capability scope gate can use it.
    const ctx = weaveContext({
      userId: auth.userId,
      metadata: { requestId: newUUIDv7(), persona: auth.persona, tenantId: auth.tenantId ?? undefined },
    });

    const a2aVersion = req.headers['a2a-version'] as string | undefined;
    const result = await getDispatcher()(ctx, { method: 'POST', body, headers: req.headers as Record<string, string>, a2aVersion });

    if (result.kind === 'json') {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
      return;
    }

    req.socket?.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(SSE_KEEPALIVE);
    }, 15_000);

    try {
      for await (const chunk of streamToSse(result.events)) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    } catch {
      // Stream errors already encoded as { task: failedTask } events
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }, { csrf: false });

  // REST backward-compat (Phase 1 clients)
  router.post('/api/a2a/tasks', async (req, res, _params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }

    let sendParams: A2ATaskSendParams;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed['message'] || typeof parsed['message'] !== 'object') {
        json(res, 400, { error: 'Invalid A2A params: must have message object' });
        return;
      }
      const msg = parsed['message'] as Record<string, unknown>;
      if (!Array.isArray(msg['parts'])) {
        json(res, 400, { error: 'Invalid A2A params: message.parts must be an array' });
        return;
      }
      sendParams = parsed as unknown as A2ATaskSendParams;
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { text: userContent, attachments } = extractPartsContent(sendParams.message.parts);
    if (!userContent.trim() && attachments.length === 0) {
      json(res, 400, { error: 'Task message must contain at least one text or file part' });
      return;
    }

    const skillRows = await db.listEnabledA2ASkills();
    const task = await runAgentTask(db, chatEngine, auth.userId, auth.persona, sendParams, userContent, attachments, skillRows);
    json(res, 200, task);
  }, { csrf: false });

  router.get('/api/a2a/tasks/:taskId', async (_req, res, params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }
    const taskId = params['taskId'] ?? 'unknown';
    const task = await taskStore.load(taskId);
    if (!task) {
      json(res, 404, { error: `Task not found: ${taskId}` });
      return;
    }
    json(res, 200, task);
  });
}

// ─── A2A server impl wrapping chat engine ─────────────────────────────────────

import type { A2AServer, A2AStreamEvent, A2AMessage, A2AListTasksFilter } from '@weaveintel/core';
import { makeFailedA2ATask, weaveAudit } from '@weaveintel/core';

function buildGeneWeaveA2AServer(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  store: A2ATaskStore,
  pushStore: A2APushNotificationStore,
): A2AServer {
  const baseUrl = process.env['GENEWEAVE_BASE_URL'] ?? 'http://localhost:3000';
  const agentUrl = `${baseUrl}/api/a2a`;

  // Lazy skills cache — loaded on first task and refreshed on getExtendedCard.
  let cachedSkillRows: A2ASkillRow[] = [];
  async function loadSkills(): Promise<A2ASkillRow[]> {
    cachedSkillRows = await db.listEnabledA2ASkills();
    return cachedSkillRows;
  }
  // Warm up eagerly so the synchronous `card` getter has data as soon as possible.
  void loadSkills();

  const baseCard = {
    name: 'geneweave',
    description: 'geneWeave — Intelligent AI orchestration assistant powered by weaveIntel',
    version: AGENT_VERSION,
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true, stateTransitionHistory: true },
    supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC' as const, protocolVersion: '1.0' }],
  };

  return {
    // Synchronous getter: returns cached skills (populated by the eager loadSkills() above).
    get card(): AgentCard {
      return { ...baseCard, skills: cachedSkillRows.map(rowToAgentSkill) } as AgentCard;
    },

    async handleMessage(ctx, params) {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];
      const submittedAt = new Date().toISOString();

      const submittedTask: A2ATask = {
        id: taskId, contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: submittedAt },
        artifacts: [], history,
        metadata: { submittedAt },
      };

      await store.save(submittedTask);
      void weaveAudit(ctx, { action: 'a2a.task.received', outcome: 'success', resource: 'geneweave', details: { taskId, contextId } });

      if (params.configuration?.returnImmediately) {
        void (async () => {
          try {
            await store.update(taskId, { status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } });
            const { text: userContent, attachments } = extractPartsContent(params.message.parts);
            const callerPersona = (ctx.metadata?.['persona'] as string | undefined) ?? 'tenant_user';
            const skillRows = cachedSkillRows.length > 0 ? cachedSkillRows : await loadSkills();
            const task = await runAgentTask(db, chatEngine, ctx.userId ?? 'a2a-anon', callerPersona, params, userContent, attachments, skillRows, taskId, contextId);
            await store.save(task);
            void deliverPushNotificationsForTask(pushStore, task).catch(() => {});
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const failedTask = await store.update(taskId, { status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString() } }).catch(() => null);
            if (failedTask) void deliverPushNotificationsForTask(pushStore, failedTask).catch(() => {});
            void weaveAudit(ctx, { action: 'a2a.task.background.error', outcome: 'failure', resource: 'geneweave', details: { taskId, error } });
          }
        })();
        return submittedTask;
      }

      await store.update(taskId, { status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } });

      const skillRows = cachedSkillRows.length > 0 ? cachedSkillRows : await loadSkills();
      let task: A2ATask;
      try {
        const { text: userContent, attachments } = extractPartsContent(params.message.parts);
        const callerPersona = (ctx.metadata?.['persona'] as string | undefined) ?? 'tenant_user';
        task = await runAgentTask(db, chatEngine, ctx.userId ?? 'a2a-anon', callerPersona, params, userContent, attachments, skillRows, taskId, contextId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        task = makeFailedA2ATask(taskId, contextId, error, history);
      }

      await store.save(task);
      return task;
    },

    async *handleStreamMessage(ctx, params): AsyncIterable<A2AStreamEvent> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];

      await store.save({
        id: taskId, contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
        artifacts: [], history,
      });

      const workingTs = new Date().toISOString();
      await store.update(taskId, { status: { state: 'TASK_STATE_WORKING', timestamp: workingTs } });
      yield { statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: workingTs } } };

      void weaveAudit(ctx, { action: 'a2a.task.stream.start', outcome: 'success', resource: 'geneweave', details: { taskId } });

      const skillRows = cachedSkillRows.length > 0 ? cachedSkillRows : await loadSkills();
      let task: A2ATask;
      try {
        const { text: userContent, attachments } = extractPartsContent(params.message.parts);
        const callerPersona = (ctx.metadata?.['persona'] as string | undefined) ?? 'tenant_user';
        task = await runAgentTask(db, chatEngine, ctx.userId ?? 'a2a-anon', callerPersona, params, userContent, attachments, skillRows, taskId, contextId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        task = makeFailedA2ATask(taskId, contextId, error, history);
      }

      await store.save(task);
      void deliverPushNotificationsForTask(pushStore, task).catch(() => {});

      if (task.artifacts.length > 0) {
        yield { artifactUpdate: { taskId, contextId, artifact: task.artifacts[0]!, append: false, lastChunk: true } };
      }

      yield { task };
    },

    async getTask(_ctx, taskId) { return store.load(taskId); },
    async listTasks(_ctx, filter?: A2AListTasksFilter) { return store.list(filter); },

    async cancelTask(_ctx, taskId) {
      const existing = await store.load(taskId);
      if (!existing) return;
      const canceled = await store.update(taskId, { status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } });
      void deliverPushNotificationsForTask(pushStore, canceled).catch(() => {});
    },

    async getExtendedCard(_ctx) {
      const rows = await loadSkills();
      return {
        ...baseCard,
        skills: rows.map(rowToAgentSkill),
        documentationUrl: `${baseUrl}/docs/a2a`,
      } as AgentCard;
    },

    async createPushConfig(_ctx, taskId, config) { return pushStore.create(taskId, config); },
    async getPushConfig(_ctx, taskId, configId) { return pushStore.get(taskId, configId); },
    async listPushConfigs(_ctx, taskId) { return pushStore.list(taskId); },
    async deletePushConfig(_ctx, taskId, configId) { return pushStore.delete(taskId, configId); },
    async start() {},
    async stop() {},
  };
}

// ─── Core A2A task runner ──────────────────────────────────────────────────────
//
// Routes through chatEngine.sendMessage() — the same pipeline as the geneWeave chat
// UI — so that external A2A callers get identical behavior to internal calls:
// skill routing, memory, redaction, guardrails, budget gate, task policies, and
// tracing all apply automatically and consistently.
//
// The only A2A-specific logic here is the capability scope gate (mode + model
// authorization) and building the A2ATask response from SendMessageResult.

async function runAgentTask(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  userId: string,
  callerPersona: string,
  sendParams: A2ATaskSendParams,
  userContent: string,
  attachments: ChatAttachment[],
  skillRows: A2ASkillRow[],
  taskId?: string,
  contextId?: string,
): Promise<A2ATask> {
  const resolvedTaskId = taskId ?? newUUIDv7();
  const resolvedContextId = contextId ?? sendParams.message.contextId ?? resolvedTaskId;
  const receivedAt = new Date().toISOString();

  // ── Layer 2: Capability scope gate ───────────────────────────────────────────
  // Validate the requested mode against the caller's persona permissions.
  const requestedMode = sendParams.metadata?.['mode'] as string | undefined;
  const { mode: resolvedMode, downgraded } = resolveA2AMode(requestedMode, callerPersona, skillRows);

  // ── Layer 2: Model override gate ─────────────────────────────────────────────
  // Only admin personas may override provider/model — prevents cost-escalation.
  const modelHint = sendParams.metadata?.['model'] as string | undefined;
  let providerOpt: string | undefined;
  let modelOpt: string | undefined;
  if (modelHint?.includes('/') && canOverrideModel(callerPersona)) {
    const slashIdx = modelHint.indexOf('/');
    providerOpt = modelHint.slice(0, slashIdx);
    modelOpt = modelHint.slice(slashIdx + 1);
  }
  // If model override is present but not authorized: silently use default (fail-closed).

  // Use the caller's specified chatId if provided (enables multi-turn A2A contexts),
  // otherwise generate a synthetic per-task ID so sessions don't cross-contaminate.
  const callerChatId = sendParams.metadata?.['chatId'] as string | undefined;
  const syntheticChatId = callerChatId ?? `a2a-${resolvedTaskId}`;

  // chatEngine.sendMessage() writes to the messages table which has a FK on chats.chat_id.
  // For synthetic (per-task) IDs we must create the chat row first.  If the caller
  // supplied an existing chatId we skip creation — that chat already exists.
  if (!callerChatId) {
    const engineCfg = (chatEngine as unknown as {
      config: { defaultProvider: string; defaultModel: string };
    }).config;
    try {
      await db.createChat({
        id: syntheticChatId,
        userId,
        title: `A2A Task ${resolvedTaskId.slice(0, 8)}`,
        model: providerOpt && modelOpt ? modelOpt : engineCfg.defaultModel,
        provider: providerOpt ?? engineCfg.defaultProvider,
      });
    } catch {
      // Idempotent: if the row already exists (concurrent retry) continue silently.
    }
  }

  // ── Layer 2.5: Resolve per-skill agent config from the a2a_skills row ─────────
  // Pick the first enabled skill that matches the resolved mode.  Its agent_tools
  // and agent_workers columns (set by admins in the A2A Skills admin tab) override
  // the mode-policy defaults, giving each skill a fully self-contained agent config.
  const matchingSkill = skillRows.find(r => r.mode === resolvedMode && r.enabled);
  const toolsOverride: string[] | undefined = matchingSkill?.agent_tools
    ? (JSON.parse(matchingSkill.agent_tools) as string[])
    : undefined;
  const workersOverride: WorkerDef[] | undefined = matchingSkill?.agent_workers
    ? (JSON.parse(matchingSkill.agent_workers) as WorkerDef[])
    : undefined;

  // ── Layers 3–5: Route through the same pipeline as the chat UI ───────────────
  // chatEngine.sendMessage() applies: skill routing, memory, redaction, guardrails
  // (pre + post), budget gate, task policies, tracing, and episodic logging.
  // modeOverride + the two new overrides give A2A tasks the same capabilities as
  // a properly configured chat — tools, workers, CSE, web search, memory — without
  // requiring a saved chat_settings row on the synthetic A2A chat.
  const sendResult = await chatEngine.sendMessage(
    userId,
    syntheticChatId,
    userContent,
    {
      provider: providerOpt,
      model: modelOpt,
      modeOverride: resolvedMode,
      attachments: attachments.length > 0 ? attachments : undefined,
      toolsOverride,
      workersOverride,
    },
  );

  const completedAt = new Date().toISOString();

  // Task is failed if: LLM didn't complete, guardrail denied, or output was empty after guardrail
  const denied = sendResult.guardrail?.decision === 'deny';
  const succeeded = !denied && Boolean(sendResult.assistantContent?.trim());

  const outputText = sendResult.assistantContent ?? '';

  // Surface scope gate results and guardrail decisions in task metadata.
  const guardrailMeta: Record<string, unknown> = {};
  if (downgraded) guardrailMeta['modeDowngraded'] = downgraded;
  if (denied) guardrailMeta['guardrail'] = { decision: 'deny', reason: sendResult.guardrail?.reason };

  return {
    id: resolvedTaskId,
    contextId: resolvedContextId,
    status: {
      state: succeeded ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
      message: succeeded
        ? undefined
        : { role: 'agent', parts: [{ text: outputText || 'Agent task failed' }] },
      timestamp: completedAt,
    },
    artifacts: succeeded
      ? [{ artifactId: `${resolvedTaskId}-output`, name: 'output', parts: [{ text: outputText }] }]
      : [],
    history: [
      { role: 'user', parts: sendParams.message.parts, contextId: resolvedContextId, messageId: newUUIDv7(), metadata: { timestamp: receivedAt } },
      { role: 'agent', parts: [{ text: outputText }], contextId: resolvedContextId, messageId: newUUIDv7(), metadata: { timestamp: completedAt } },
    ],
    metadata: {
      submittedAt: receivedAt,
      resolvedMode,
      callerPersona,
      latencyMs: sendResult.latencyMs,
      activeSkills: sendResult.activeSkills?.map(s => s.id),
      ...(attachments.length > 0 ? { attachmentCount: attachments.length, attachmentTypes: [...new Set(attachments.map(a => a.mimeType))] } : {}),
      ...(Object.keys(guardrailMeta).length > 0 ? { guardrail: guardrailMeta } : {}),
    },
  };
}
