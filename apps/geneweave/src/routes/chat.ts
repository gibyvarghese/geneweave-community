import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine, ChatAttachment } from '../chat.js';
import { DashboardService } from '../dashboard.js';
import { recordChatFeedbackSignal } from '../routing-feedback.js';
import { sanitizeFeedbackCategories } from '@weaveintel/collab';
import { json, html, readBody, LARGE_REQUEST_BODY_BYTES } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createActionItem } from '@weaveintel/human-tasks';
import { meTaskRepo } from './me-stores.js';

type PolicyCheck = { tool: string; policy: string; taskType: string; priority: string };

async function createTasksFromPolicyChecks(userId: string, checks: PolicyCheck[]): Promise<void> {
  for (const check of checks) {
    const task = createActionItem({
      assignee: userId,
      title: `Review: ${check.policy}`,
      description: `Agent used tool "${check.tool}" — policy "${check.policy}" requires your review.`,
      priority: check.priority as Parameters<typeof createActionItem>[0]['priority'],
      data: { actionable: check.taskType === 'approval', policyName: check.policy, toolName: check.tool },
      provenance: { sourceRef: 'policy', createdBy: 'system' as const },
    });
    await meTaskRepo.save(task);
  }
}

export function registerChatRoutes(
  router: Router,
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  dashboard: DashboardService,
  workflowEngine?: { getStatus?: () => unknown },
): void {
  chatEngine.onPolicyChecks = createTasksFromPolicyChecks;

  // ── Chat routes ────────────────────────────────────────

  // Chat routes delegate to ChatEngine which orchestrates WeaveIntel:
  //   • GET /api/chats          — list user’s conversations
  //   • POST /api/chats         — create a new chat (sets model + provider)
  //   • POST /api/chats/:id/messages — send a message, returns SSE stream
  //     ChatEngine.streamMessage() wires: redaction → guardrails → model → eval────

  router.get('/api/chats', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chats = await db.getUserChats(auth.userId);
    json(res, 200, { chats });
  });

  router.post('/api/chats', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { title?: string; model?: string; provider?: string };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        json(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }
      body = parsed;
    } catch { body = {}; }

    const chatId = newUUIDv7();
    const chat = {
      id: chatId,
      userId: auth.userId,
      title: body.title ?? 'New Chat',
      model: body.model ?? (chatEngine as any).config.defaultModel,
      provider: body.provider ?? (chatEngine as any).config.defaultProvider,
    };
    await db.createChat(chat);
    const created = await db.getChat(chatId, auth.userId);
    json(res, 201, { chat: created });
  }, { auth: true, csrf: true });

  router.get('/api/chats/:chatId/messages', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const messages = await db.getMessages(chat.id);
    json(res, 200, { messages });
  });

  router.put('/api/chats/:chatId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: { title?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const title = String(body.title ?? '').trim();
    if (!title) { json(res, 400, { error: 'title required' }); return; }

    await db.updateChatTitle(chat.id, auth.userId, title.slice(0, 200));
    const updated = await db.getChat(chat.id, auth.userId);
    json(res, 200, { chat: updated });
  }, { auth: true, csrf: true });

  router.post('/api/chats/:chatId/messages', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req, { maxBytes: LARGE_REQUEST_BODY_BYTES });
    let body: {
      content?: string;
      stream?: boolean;
      model?: string;
      provider?: string;
      maxTokens?: number;
      temperature?: number;
      attachments?: ChatAttachment[];
    };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const normalizedContent = typeof body.content === 'string' ? body.content.trim() : '';

    const normalizedAttachments = Array.isArray(body.attachments)
      ? body.attachments
          .slice(0, 8)
          .filter((a): a is ChatAttachment => {
            return !!a
              && typeof a.name === 'string'
              && a.name.trim().length > 0
              && typeof a.mimeType === 'string'
              && a.mimeType.trim().length > 0
              && typeof a.size === 'number'
              && Number.isFinite(a.size)
              && a.size > 0
              && a.size <= 4 * 1024 * 1024;
          })
      : undefined;

    if (!normalizedContent && (!normalizedAttachments || normalizedAttachments.length === 0)) {
      json(res, 400, { error: 'content or attachments required' });
      return;
    }

    const opts = {
      model: body.model ?? chat.model,
      provider: body.provider ?? chat.provider,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      attachments: normalizedAttachments,
    };

    if (body.stream) {
      await chatEngine.streamMessage(res, auth.userId, chat.id, normalizedContent, opts);
    } else {
      try {
        const result = await chatEngine.sendMessage(auth.userId, chat.id, normalizedContent, opts);
        if (result.policyChecks?.length) {
          await createTasksFromPolicyChecks(auth.userId, result.policyChecks).catch(() => {});
        }
        json(res, 200, result);
      } catch (err) {
        // Agent/supervisor mode can fail under transient load; return structured error
        // rather than letting the uncaught exception become a raw 500.
        const msg = err instanceof Error ? err.message : String(err);
        const isOverload = msg.includes('ECONNRESET') || msg.includes('timeout') || msg.includes('429');
        json(res, isOverload ? 503 : 422, {
          error: isOverload ? 'Service temporarily overloaded — retry shortly' : 'Message processing failed',
          detail: msg.slice(0, 200),
          correlationId: newUUIDv7(),
        });
      }
    }
  }, { auth: true, csrf: true });

  // Dedicated SSE streaming endpoint — always streams, no JSON fallback.
  router.post('/api/chats/:chatId/messages/stream', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const raw = await readBody(req, { maxBytes: LARGE_REQUEST_BODY_BYTES });
    let body: { content?: string; model?: string; provider?: string; maxTokens?: number; temperature?: number };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const normalizedContent = typeof body.content === 'string' ? body.content.trim() : '';
    if (!normalizedContent) { json(res, 400, { error: 'content required' }); return; }
    const opts = {
      model: body.model ?? chat.model,
      provider: body.provider ?? chat.provider,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    };
    await chatEngine.streamMessage(res, auth.userId, chat.id, normalizedContent, opts);
  }, { auth: true, csrf: true });

  router.del('/api/chats/:chatId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    // Ownership check: getChat scopes by userId, so a cross-user chatId returns null
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    await db.deleteChat(params['chatId']!, auth.userId);
    // Phase 5: session end → invalidate this user's cached entries (event-driven).
    try {
      const { emitCacheEvent } = await import('../cache-invalidator.js');
      const { cacheScopeKeyString } = await import('@weaveintel/cache');
      const actor = await db.getUserById(auth.userId);
      const scopePrefix = cacheScopeKeyString({ tenantId: actor?.tenant_id ?? null, userId: auth.userId, scope: 'user' }) + '||';
      await emitCacheEvent('session_end', { scopePrefix, userId: auth.userId });
    } catch { /* best-effort */ }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── anyWeave Phase 5: Chat feedback bridge ─────────────
  // Authenticated users can submit a 👍/👎/regenerate/copy signal on any
  // assistant message. The signal is persisted to message_feedback and a
  // capability signal is recorded that updates production_signal_score on
  // the resolved (model, provider, task_key) row.
  router.post('/api/messages/:id/feedback', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const messageId = params['id']!;
    const raw = await readBody(req);
    let body: {
      signal?: string;
      comment?: string | null;
      categories?: unknown;
      modelId?: string;
      provider?: string;
      taskKey?: string;
      chatId?: string;
    };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const validSignals = new Set(['thumbs_up', 'thumbs_down', 'regenerate', 'copy']);
    if (!body.signal || !validSignals.has(body.signal)) {
      json(res, 400, { error: 'signal must be one of thumbs_up|thumbs_down|regenerate|copy' });
      return;
    }
    // m137: a thumbs-down may carry a small fixed taxonomy of reasons (validated against the shared list),
    // stored alongside the signal so down-votes become an actionable reason, not just free text. modelId/
    // provider/taskKey stay OPTIONAL: when present the feedback also updates the model's routing quality
    // score; when absent (message decision not snapshotted) the raw feedback is still recorded.
    const categories = body.signal === 'thumbs_down' ? sanitizeFeedbackCategories(body.categories) : [];
    try {
      const result = await recordChatFeedbackSignal(db, {
        signal: body.signal,
        messageId,
        modelId: body.modelId ?? null,
        provider: body.provider ?? null,
        taskKey: body.taskKey ?? null,
        tenantId: auth.tenantId ?? null,
        chatId: body.chatId ?? null,
        userId: auth.userId,
        comment: body.comment ?? null,
        categories,
      });
      json(res, 201, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: msg });
    }
  }, { auth: true, csrf: true });

  // ── Dashboard routes ───────────────────────────────────

  // Dashboard routes use DashboardService which queries the metrics table.
  // Each endpoint returns aggregated data for the authenticated user:
  //   • /overview     — total chats, messages, token usage, cost summary
  //   • /costs        — per-model cost breakdown over time
  //   • /performance  — latency percentiles and throughput
  //   • /evals        — eval assertion results (pass/fail/score)────

  router.get('/api/dashboard/overview', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getOverview(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/costs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getCostBreakdown(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/performance', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getPerformance(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/evals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const evals = await db.getEvals(auth.userId, from, to);
    json(res, 200, { evals });
  });


}
