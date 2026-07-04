import { newUUIDv7, createLogger } from '@weaveintel/core';

const logger = createLogger('chat-stream-message');
import type { ServerResponse } from 'node:http';
import type { ExecutionContext, Message, AgentStep, ModelRequest, ModelHealth, RuntimeRoutingSlot } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { applySkillsToPrompt } from '@weaveintel/skills';
import type { DurableConsentManager } from '@weaveintel/guardrails/compliance';
import type { DatabaseAdapter } from './db.js';
import { normalizePersona } from './rbac.js';
import { buildReasoningRequestMetadata, reasoningAdjustedTemperature, reasoningAdjustedMaxTokens, type ReasoningRequestMetadata } from './chat-reasoning-utils.js';
import {
  calculateCost,
  getOrCreateModel,
  settingsFromRow,
  type ChatAttachment,
  type ChatEngineConfig,
  type ChatSettings,
} from './chat-runtime.js';
import type { ModelPricing } from './chat-pricing-utils.js';
import {
  composeUserInput,
  hasTabularDataAttachments,
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval, SUPERVISOR_INTERNAL_TOOLS } from './chat-eval-utils.js';
import { historyToMessages, extractToolEvidence } from './chat-message-utils.js';
import { recordTraceSpans, withLLMSpan, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import type { CacheTurnMetrics } from './chat-send-message.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import { resolveSystemPrompt, buildCapabilityTelemetrySnapshots } from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';
import { shouldBypass, shouldBypassResponse, isCacheableTemperature, cacheScopeKey, cacheScopeKeyString, planPromptCacheBreakpoints } from '@weaveintel/cache';
import type { CachePolicy, SemanticCache } from '@weaveintel/core';
import { semanticLookup, semanticStore, type SemanticConfig } from './chat-semantic-utils.js';
import { readResponseWithSwr, writeResponseWithSwr, readNegativeCache, writeNegativeCache } from './cache-stampede.js';
import type { LeaderHandle } from '@weaveintel/cache';
import { recordThroughput, getP50MsPerToken, ADAPTIVE_BUDGET_SAFETY_FACTOR, ADAPTIVE_BUDGET_MIN_MS } from '@weaveintel/resilience';
import {
  buildMemoryContext,
  resolveIdentityRecallFromMemory,
  saveToMemory,
  loadProceduralInstructions,
  buildEpisodicContext,
  buildWorkingMemoryContext,
} from './chat-memory-utils.js';
import { triggerConsolidationForUser } from './memory-consolidation.js';
import { createI18nService } from './i18n-sql.js';

type StreamMessageDeps = {
  config: ChatEngineConfig;
  db: DatabaseAdapter;
  healthTracker: RuntimeRoutingSlot;
  // Phase 1: shared response cache + key builder (same instances as the
  // non-streaming send path) so streamed turns also read/write the response cache.
  responseCache: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown, ttlMs: number) => Promise<void>;
  };
  cacheKeyBuilder: { build: (input: Record<string, string | number | boolean>) => string };
  getAvailableModels: () => Promise<Array<{ id: string; provider: string }>>;
  withResponseCardFormatPolicy: (basePrompt: string | undefined) => Promise<string | undefined>;
  streamAgent: (
    res: ServerResponse,
    ctx: ExecutionContext,
    model: any,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ) => Promise<AgentRunTelemetry>;
  writeSseEvent: (res: ServerResponse, payload: Record<string, unknown>) => Promise<boolean>;
  endSse: (res: ServerResponse) => void;
  loadPricing: () => Promise<Map<string, ModelPricing>>;
  recordModelOutcome: (modelId: string, providerId: string, latencyMs: number, success: boolean, errorMessage?: string) => void;
  safeParseJson: (text: string) => unknown;
  /** Optional hook: called after policy checks are evaluated (best-effort, never blocks the stream). */
  onPolicyChecks?: (userId: string, checks: Array<{ tool: string; policy: string; taskType: string; priority: string }>) => Promise<void>;
  consentManager?: DurableConsentManager | null;
  /** Phase 3 — record this turn's cache effectiveness into the live sink + durable rollup. */
  recordCacheMetrics?: (turn: CacheTurnMetrics) => void;
  /** Phase 4 — scoped embedding-similarity cache (from the runtime cache slot). */
  semanticCache?: SemanticCache;
  /** Phase 4 — resolve the DB-driven semantic cache config (60s cached). */
  loadSemanticConfig?: () => Promise<SemanticConfig | null>;
  /** Phase 5 — resolve the dynamic cache-key version token (60s cached). */
  loadCacheVersion?: () => Promise<string>;
  /** Phase 7 — process-wide singleflight to coalesce concurrent identical misses. */
  singleflight?: import('@weaveintel/cache').Singleflight;
  /** Phase 7 — resolve the DB-driven stampede config (enabled + negative TTL, 60s cached). */
  loadStampedeConfig?: () => Promise<{ enabled: boolean; negativeTtlMs: number }>;
};

async function isAnalyticsAllowed(consentManager: DurableConsentManager | null | undefined, userId: string): Promise<boolean> {
  if (!consentManager) return true;
  try {
    const flags = await consentManager.listBySubject(userId);
    const flag = flags.find(f => f.purpose === 'analytics');
    if (!flag) return true;
    return consentManager.isGranted(userId, 'analytics');
  } catch { return true; }
}

/**
 * Fallback title from raw text — first non-empty line trimmed to ~60 chars.
 * Only used when the LLM-based titler fails.
 */
function deriveChatTitleFallback(content: string): string {
  const firstLine = String(content || '').split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0) || '';
  if (!firstLine) return 'New Chat';
  const max = 60;
  if (firstLine.length <= max) return firstLine;
  const slice = firstLine.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 30 ? slice.slice(0, lastSpace) : slice).trimEnd() + '\u2026';
}

function sanitizeGeneratedTitle(raw: string): string {
  let t = String(raw || '').trim();
  // Strip surrounding quotes
  t = t.replace(/^["'`\u201C\u2018]+|["'`\u201D\u2019]+$/g, '').trim();
  // Strip trailing punctuation
  t = t.replace(/[.!?:;,\s]+$/g, '').trim();
  // Single line only
  t = t.split(/\r?\n/)[0]?.trim() || '';
  // Cap length
  if (t.length > 80) {
    const slice = t.slice(0, 80);
    const lastSpace = slice.lastIndexOf(' ');
    t = (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trimEnd();
  }
  return t;
}

/**
 * Use the LLM to generate a short topic-style chat title (3-7 words) from the
 * conversation so far. If the existing title still fits the topic, returns
 * null to leave it alone. Best-effort — returns null on any failure.
 */
async function generateChatTitleViaLLM(
  model: any,
  ctx: any,
  currentTitle: string,
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  const trimmedUser = String(userMessage || '').slice(0, 1500);
  const trimmedReply = String(assistantReply || '').slice(0, 1500);
  const isDefault = !currentTitle || currentTitle === 'New Chat';
  const instruction = isDefault
    ? 'Generate a concise topic title (3-7 words, Title Case, no punctuation, no quotes) that summarizes what the user is asking about. Return ONLY the title text.'
    : `The current chat title is: "${currentTitle}". If it still summarizes the conversation well, respond with exactly the word KEEP. Otherwise return a new concise topic title (3-7 words, Title Case, no punctuation, no quotes). Return ONLY the title text or KEEP.`;
  const prompt = [
    instruction,
    '',
    `User message: ${trimmedUser}`,
    '',
    `Assistant reply: ${trimmedReply}`,
  ].join('\n');
  try {
    const resp = await model.generate(ctx, {
      messages: [
        { role: 'system', content: 'You write very short, descriptive chat titles. Output a title only — no quotes, no punctuation, no preamble.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 30,
    });
    const raw = String(resp?.content ?? '').trim();
    if (!raw) return null;
    if (/^keep$/i.test(raw.replace(/[^a-z]/gi, ''))) return null;
    const cleaned = sanitizeGeneratedTitle(raw);
    if (!cleaned) return null;
    if (cleaned.toLowerCase() === currentTitle.toLowerCase()) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * Auto-title a chat using the LLM. Runs after each assistant reply:
 *   - If the chat title is the default ('New Chat'), always generate one.
 *   - Otherwise, ask the LLM whether the existing title still fits the
 *     evolving conversation and replace it if not.
 * Always best-effort — returns null on any failure and never throws.
 */
async function maybeAutoTitleChat(
  db: DatabaseAdapter,
  userId: string,
  chatId: string,
  userContent: string,
  assistantReply: string,
  model: any,
  ctx: any,
): Promise<string | null> {
  try {
    const chat = await db.getChat(chatId, userId);
    if (!chat) return null;
    const current = String(chat.title || '').trim();
    const isDefault = !current || current === 'New Chat';

    let next = await generateChatTitleViaLLM(model, ctx, current, userContent, assistantReply);

    // Fallback for the first message only — never overwrite a real title with a raw-text fallback.
    if (!next && isDefault) {
      next = deriveChatTitleFallback(userContent);
    }
    if (!next) return null;
    if (next === current) return null;

    await db.updateChatTitle(chatId, userId, next.slice(0, 200));
    return next;
  } catch {
    return null;
  }
}

// ─── SSE heartbeat ───────────────────────────────────────────────────────────
// Emits SSE comment pings every intervalMs so reverse proxies (Nginx, ALB, etc.)
// with aggressive idle-connection timeouts don't kill long-running streams.
// SSE comment lines (": ...") are invisible to client EventSource listeners.
function startSseHeartbeat(
  res: ServerResponse,
  intervalMs = 12_000,
): { stop: () => void } {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': ping\n\n');
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

// ─── Stream budget policy ────────────────────────────────────────────────────
// Static category baselines — used as both the initial budget and the hard cap
// for the Phase 5 adaptive budget.  The TTFT guard is never shrunk adaptively.
const STREAM_BUDGETS = {
  agentChain:   { deadlineMs: 10 * 60_000, ttftMs: 45_000 },
  fileAnalysis: { deadlineMs:  5 * 60_000, ttftMs: 30_000 },
  simpleChat:   { deadlineMs:  2 * 60_000, ttftMs: 20_000 },
} as const;

/**
 * Phase 5 — estimate how many output tokens a request is likely to produce.
 * Used together with the observed P50 ms/token to derive an adaptive deadline.
 * Pure heuristic: input token count × a mode-specific output ratio.
 */
function estimateOutputTokens(content: string, mode: string, hasAttachments: boolean): number {
  const inputTokens = Math.ceil(content.length / 4);  // 1 token ≈ 4 chars
  if (mode === 'agent' || mode === 'supervisor' || mode === 'ensemble') {
    return Math.min(4096, Math.max(500, Math.floor(inputTokens * 0.8)));
  }
  if (hasAttachments) {
    return Math.min(2000, Math.max(400, Math.floor(inputTokens * 0.4)));
  }
  return Math.min(1000, Math.max(300, Math.floor(inputTokens * 0.5)));
}

/**
 * Select the streaming deadline and TTFT budget for this request.
 *
 * Phase 5 adaptive path (fires only when ≥ 5 throughput samples exist for
 * the endpoint): `deadlineMs = clamp(estimated_tokens × p50MsPerToken × 1.5,
 * ADAPTIVE_BUDGET_MIN_MS, static_baseline)`. When cold (< 5 samples) or when
 * the adaptive value exceeds the static cap, falls back to the static baseline.
 */
function selectStreamBudget(
  mode: string,
  attachments: ChatAttachment[],
  content?: string,
  endpointId?: string,
): { deadlineMs: number; ttftMs: number } {
  const baseline = (() => {
    if (mode === 'agent' || mode === 'supervisor' || mode === 'ensemble') {
      return STREAM_BUDGETS.agentChain;
    }
    if (hasTabularDataAttachments(attachments) || attachments.length > 0) {
      return STREAM_BUDGETS.fileAnalysis;
    }
    return STREAM_BUDGETS.simpleChat;
  })();

  if (content && endpointId) {
    const p50MsPerToken = getP50MsPerToken(endpointId);
    if (p50MsPerToken !== undefined) {
      const estimated = estimateOutputTokens(content, mode, attachments.length > 0);
      const adaptive = Math.round(estimated * p50MsPerToken * ADAPTIVE_BUDGET_SAFETY_FACTOR);
      const deadlineMs = Math.max(ADAPTIVE_BUDGET_MIN_MS, Math.min(baseline.deadlineMs, adaptive));
      return { deadlineMs, ttftMs: baseline.ttftMs };
    }
  }

  return baseline;
}

export async function streamMessageImpl(
  deps: StreamMessageDeps,
  res: ServerResponse,
  userId: string,
  chatId: string,
  content: string,
  opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
): Promise<void> {
  // SSE streams can legitimately run for minutes (large CSV analysis, long agent
  // chains). Disable the server-level requestTimeout on this socket so the
  // 30-second global limit doesn't kill streaming connections mid-response.
  (res.socket ?? (res as any).connection)?.setTimeout(0);

  const requestStartMs = Date.now();
  let provider = opts?.provider ?? deps.config.defaultProvider;
  let modelId = opts?.model ?? deps.config.defaultModel;
  let providerCfg = deps.config.providers[provider];

  const blocked = deps.healthTracker.getBlockedProviders();
  // An explicit model override PINS the model and bypasses the router (e.g. a
  // run that wants a specific reasoning model). Otherwise the router decides.
  const pinned = typeof opts?.model === 'string' && opts.model.length > 0;
  const routed = pinned ? null : await routeModel(deps.db, await deps.getAvailableModels(), deps.healthTracker.listHealth(), { ...opts, prompt: content }, blocked);
  // Snapshot the resolved routing task so the `done` event can carry it — the UI passes it back when the
  // reader rates the answer, which lets that feedback update the model's routing quality score (m137).
  const resolvedTaskKey: string | null = routed?.taskKey ?? null;
  if (routed && deps.config.providers[routed.provider]) {
    provider = routed.provider;
    modelId = routed.modelId;
    providerCfg = deps.config.providers[provider];
  }

  if (!providerCfg) {
    provider = deps.config.defaultProvider;
    modelId = deps.config.defaultModel;
    providerCfg = deps.config.providers[provider];
  }
  if (!providerCfg) {
    const first = Object.entries(deps.config.providers)[0];
    if (!first) throw new Error('No providers configured');
    [provider, providerCfg] = first;
    modelId = deps.config.defaultModel;
  }

  const model = await getOrCreateModel(provider, modelId, providerCfg);
  const actor = await deps.db.getUserById(userId);
  const userPersona = normalizePersona(actor?.persona, 'user');
  const tenantId = actor?.tenant_id ?? null;
  const settings = settingsFromRow(await deps.db.getChatSettings(chatId));
  const resolvedSystemPrompt = await resolveSystemPrompt(deps.db, settings);
  const resolvedPrompt = await deps.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
  // Resolve attachments early so budget selection can inspect them.
  const attachments = normalizeAttachments(opts?.attachments);
  // Phase 5: pass content + resolved provider so adaptive budget can use P50 ms/token.
  const streamBudget = selectStreamBudget(settings.mode, attachments, content, `${provider}:rest`);
  const traceId = newUUIDv7();
  const abortController = new AbortController();
  let clientDisconnected = false;
  const onClientClose = () => {
    clientDisconnected = true;
    abortController.abort();
  };
  res.once('close', onClientClose);

  const ctx = weaveContext({
    runtime: deps.config.runtime,
    userId,
    deadline: Date.now() + streamBudget.deadlineMs,
    signal: abortController.signal,
    metadata: { traceId, chatId },
  });

  const contentWithAttachments = composeUserInput(content, attachments);

  let processedContent = contentWithAttachments;
  let redactionInfo: { count: number; types: string[] } | undefined;
  if (settings.redactionEnabled) {
    const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
    if (rd.error) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const denyContent = 'Your message could not be processed safely because redaction failed before execution.';
      await deps.writeSseEvent(res, { type: 'text', text: denyContent });
      await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: denyContent, error: rd.error });
      await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
      deps.endSse(res);
      await deps.db.addMessage({
        id: newUUIDv7(),
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: denyContent },
          redaction: { error: rd.error },
          traceId,
        }),
      });
      return;
    }
    processedContent = rd.redacted;
    if (rd.wasModified) {
      redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
    }
  }

  // Phase 0: pre-LLM input guardrail gate on stream path. Mirrors the
  // send-message gate — runs on post-redaction content, fail-open.
  if (deps.config.runtime?.guardrails?.checkInput) {
    try {
      const inputCheck = await deps.config.runtime.guardrails.checkInput(ctx, processedContent);
      if (!inputCheck.allow) {
        const denyContent = inputCheck.reason ?? 'Your message was blocked by a content guardrail.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        await deps.writeSseEvent(res, { type: 'text', text: denyContent });
        await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: denyContent });
        await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
        deps.endSse(res);
        await deps.db.addMessage({
          id: newUUIDv7(), chatId, role: 'assistant', content: denyContent,
          metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: denyContent }, traceId }),
        });
        return;
      }
    } catch {
      // fail-open on check error
    }
  }

  // Phase 3: per-user/tenant budget gate on stream path. Mirrors send-message gate.
  if (deps.config.runtime?.cost) {
    try {
      const budgetCheck = await deps.config.runtime.cost.gate({ userId, tenantId });
      if (!budgetCheck.allowed) {
        const denyContent = budgetCheck.reason ?? 'Your spending limit has been reached.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        await deps.writeSseEvent(res, { type: 'text', text: denyContent });
        await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: denyContent });
        await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
        deps.endSse(res);
        await deps.db.addMessage({
          id: newUUIDv7(), chatId, role: 'assistant', content: denyContent,
          metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: denyContent }, traceId }),
        });
        return;
      }
    } catch {
      // fail-open on gate error
    }
  }

  const streamSkillContext = await discoverSkillsForInput(
    deps.db,
    processedContent,
    model,
    ctx,
    settings.mode,
    (t) => deps.safeParseJson(t),
    { hasTabularAttachment: hasTabularDataAttachments(attachments) },
  );
  const streamSkillPrompt = applySkillsToPrompt(
    resolvedPrompt,
    streamSkillContext.matches,
    settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
    processedContent,
  );
  const streamEnabledTools = Array.from(new Set([...settings.enabledTools, ...streamSkillContext.toolNames]));
  const streamSkillPolicyKey = streamSkillContext.matches[0]?.skill.toolPolicyKey;
  const streamSkillTools = streamEnabledTools.filter((tool) => !settings.enabledTools.includes(tool));
  const streamActiveSkills = streamSkillContext.matches.map((m) => ({
    id: m.skill.id,
    name: m.skill.name,
    description: m.skill.description ?? m.skill.summary,
    category: m.skill.category ?? 'general',
    score: Number(m.score.toFixed(3)),
    tools: [...(m.skill.toolNames ?? [])],
  }));

  const userMsgId = newUUIDv7();
  const userMetadata = redactionInfo || attachments.length > 0
    ? JSON.stringify({
        redaction: redactionInfo,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    : undefined;
  // CR-1: Always persist the post-redaction form of the message. The raw `content`
  // (which may contain PII) is used only for in-memory processing above this point
  // and must never be written to the database when redaction is active.
  await deps.db.addMessage({ id: userMsgId, chatId, role: 'user', content: processedContent, metadata: userMetadata });

  // Load history now so turn number is available for condition context.
  const history = await deps.db.getMessages(chatId);
  const turnNumber = Math.ceil(history.length / 2);

  const preGuardrail = await evaluateGuardrails(
    deps.db, chatId, userMsgId, processedContent, 'pre-execution',
    undefined,
    { persona: userPersona, chatMode: settings.mode, turnNumber, tenantId },
  );
  if (preGuardrail.decision === 'deny') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
    await deps.writeSseEvent(res, { type: 'text', text: denyContent });
    await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: preGuardrail.reason });
    if (preGuardrail.cognitive) {
      await deps.writeSseEvent(res, { type: 'cognitive', ...preGuardrail.cognitive });
    }
    await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
    deps.endSse(res);
    await deps.db.addMessage({
      id: newUUIDv7(),
      chatId,
      role: 'assistant',
      content: denyContent,
      metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason }, cognitive: preGuardrail.cognitive }),
    });
    // Episodic logging: always capture the turn even when guardrail blocks LLM processing.
    // Memory governance will redact any PII before the entry is persisted.
    try {
      await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, denyContent, tenantId ?? undefined);
    } catch { /* episodic capture is best-effort */ }
    return;
  }

  const identityRecall = await resolveIdentityRecallFromMemory(deps.db, userId, processedContent);
  if (identityRecall) {
    const latencyMs = Date.now() - requestStartMs;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (redactionInfo) {
      await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
    }
    await deps.writeSseEvent(res, { type: 'text', text: identityRecall });
    const recallTitle = await maybeAutoTitleChat(deps.db, userId, chatId, content, identityRecall, model, ctx);
    await deps.writeSseEvent(res, {
      type: 'done',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs,
      model: 'memory-recall',
      provider: 'local',
      mode: settings.mode,
      title: recallTitle ?? undefined,
    });

    await deps.db.addMessage({
      id: newUUIDv7(),
      chatId,
      role: 'assistant',
      content: identityRecall,
      metadata: JSON.stringify({
        model: 'memory-recall',
        provider: 'local',
        streamed: true,
        mode: settings.mode,
        memoryRecall: { deterministic: true, identity: true },
        traceId,
      }),
      tokensUsed: 0,
      cost: 0,
      latencyMs,
    });

    if (await isAnalyticsAllowed(deps.consentManager, userId)) {
      await deps.db.recordMetric({
        id: newUUIDv7(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });
    }

    deps.endSse(res);
    return;
  }

  // ── Phase 1: response cache (streaming path) ──────────────────────────────
  // Mirror the non-streaming send path: resolve the active cache policy, build a
  // scope-isolated salted-SHA-256 key, and on a hit replay the cached answer as
  // SSE instead of calling the model. Multimodal turns are never cached.
  const streamAllowCache = attachments.length === 0;
  const streamCachePolicy: CachePolicy | null = streamAllowCache
    ? await resolveActiveCache(deps.db, settings.mode)
    : null;
  // Phase 5: visible scope prefix + hashed prompt + dynamic version (same as send).
  const streamScopePrefix = cacheScopeKeyString({
    tenantId,
    userId,
    scope: streamCachePolicy?.scope,
    tenantIsolation: streamCachePolicy?.tenantIsolation,
  });
  const streamCacheVersion = deps.loadCacheVersion ? await deps.loadCacheVersion() : 'v1';
  const streamCacheKey = (streamScopePrefix ? streamScopePrefix + '||' : '') + deps.cacheKeyBuilder.build({
    model: modelId,
    prompt: processedContent,
    _gv: streamCacheVersion,
  });
  // Phase 7 — stampede config + effective SWR / negative-cache windows.
  const streamStampedeCfg = (streamCachePolicy && deps.loadStampedeConfig) ? await deps.loadStampedeConfig() : { enabled: false, negativeTtlMs: 0 };
  const streamSwrMs = streamCachePolicy?.swrMs ?? 0;
  const streamNegTtlMs = streamCachePolicy?.negativeTtlMs || streamStampedeCfg.negativeTtlMs || 0;

  /** Replay a fully-formed answer as SSE (cache hit / SWR-stale / coalesced / negative). */
  const emitCachedSse = async (
    content: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    extra: { semantic?: boolean; coalesced?: boolean; stale?: boolean; negative?: boolean },
  ): Promise<void> => {
    const cacheLatencyMs = Date.now() - requestStartMs;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (redactionInfo) await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
    await deps.writeSseEvent(res, { type: 'text', text: content });
    await deps.writeSseEvent(res, {
      type: 'done', usage, cost: 0, latencyMs: cacheLatencyMs,
      model: modelId, provider, mode: settings.mode, cached: true, traceId, ...extra,
    });
    await deps.db.addMessage({
      id: newUUIDv7(), chatId, role: 'assistant', content,
      metadata: JSON.stringify({ model: modelId, provider, streamed: true, mode: settings.mode, cached: true, traceId, ...extra }),
      tokensUsed: usage.totalTokens, cost: 0, latencyMs: cacheLatencyMs,
    });
    if (!extra.negative) {
      try { await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, content, tenantId ?? undefined); } catch { /* best-effort */ }
    }
    deps.recordCacheMetrics?.({ responseHit: true, responseEligible: true, promptCacheReadTokens: 0, promptCacheWriteTokens: 0, provider, inputCostPer1M: 0 });
    deps.endSse(res);
  };

  if (streamCachePolicy && !shouldBypass(streamCachePolicy, processedContent)) {
    // Phase 7 negative cache: an identical request that recently failed is shielded.
    if (streamNegTtlMs > 0 && await readNegativeCache(deps.responseCache, streamCacheKey)) {
      await emitCachedSse('This request recently failed and is being rate-limited briefly to protect the service. Please try again shortly.', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, { negative: true });
      return;
    }
    // Phase 7 SWR: serve fresh OR stale (within the swr window) from cache.
    const swrRead = await readResponseWithSwr(deps.responseCache, streamCacheKey, { ttlMs: streamCachePolicy.ttlMs, swrMs: streamSwrMs });
    if (swrRead.value) {
      await emitCachedSse(swrRead.value.content, swrRead.value.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, { stale: swrRead.state === 'stale' });
      return;
    }
  }

  // Phase 4: on an exact-match miss, try the scoped semantic cache (paraphrase
  // match). On a hit, replay the cached answer as SSE — no LLM call.
  const streamSemanticCfg = (deps.semanticCache && deps.loadSemanticConfig)
    ? await deps.loadSemanticConfig()
    : null;
  if (streamSemanticCfg) {
    const semHit = await semanticLookup(deps.semanticCache, streamSemanticCfg, processedContent, tenantId, userId);
    if (semHit) {
      const semLatencyMs = Date.now() - requestStartMs;
      const semUsage = semHit.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (redactionInfo) await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
      await deps.writeSseEvent(res, { type: 'text', text: semHit.content });
      await deps.writeSseEvent(res, {
        type: 'done', usage: semUsage, cost: 0, latencyMs: semLatencyMs,
        model: modelId, provider, mode: settings.mode, cached: true, semantic: true, traceId,
      });
      await deps.db.addMessage({
        id: newUUIDv7(), chatId, role: 'assistant', content: semHit.content,
        metadata: JSON.stringify({ model: modelId, provider, streamed: true, mode: settings.mode, cached: true, semantic: true, traceId }),
        tokensUsed: semUsage.totalTokens, cost: 0, latencyMs: semLatencyMs,
      });
      try {
        await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, semHit.content, tenantId ?? undefined);
      } catch { /* episodic capture is best-effort */ }
      deps.recordCacheMetrics?.({ responseHit: true, responseEligible: true, promptCacheReadTokens: 0, promptCacheWriteTokens: 0, provider, inputCostPer1M: 0 });
      deps.endSse(res);
      return;
    }
  }

  // Phase 7 stampede protection (streaming): if an identical turn is already in
  // flight, this request becomes a FOLLOWER — it waits for the leader's result
  // and replays it (one model call serves both). Otherwise it is the LEADER and
  // resolves the in-flight promise once its answer is final (see below). The res
  // 'finish'/'close' events guarantee the leader always settles, so a follower
  // never hangs — on leader failure the follower simply recomputes.
  let sfLeader: LeaderHandle<string> | undefined;
  if (deps.singleflight && streamStampedeCfg.enabled && streamCachePolicy && !shouldBypass(streamCachePolicy, processedContent)) {
    const handle = deps.singleflight.beginOrJoin<string>(streamCacheKey);
    if (!handle.leader) {
      const leaderText = await handle.join.catch(() => null);
      if (typeof leaderText === 'string' && leaderText.trim().length > 0) {
        await emitCachedSse(leaderText, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, { coalesced: true });
        return;
      }
      // Leader failed / produced nothing → become the leader for our own compute.
      const retry = deps.singleflight.beginOrJoin<string>(streamCacheKey);
      if (retry.leader) sfLeader = retry;
    } else {
      sfLeader = handle;
    }
    if (sfLeader) {
      const L = sfLeader;
      // Guaranteed settle: if the stream ends/aborts without an explicit resolve,
      // reject so any followers fall through and recompute (never hang).
      res.once('finish', () => L.reject(new Error('stream ended without result')));
      res.once('close', () => L.reject(new Error('stream closed')));
    }
  }

  const messages = historyToMessages(history);
  patchLatestUserMessage(messages, processedContent);

  const [streamMemoryContext, streamProceduralInstructions, streamEpisodicContext, streamWorkingMemoryContext] = await Promise.all([
    buildMemoryContext(deps.db, ctx, model, userId, processedContent),
    loadProceduralInstructions(deps.db, userId),
    buildEpisodicContext(deps.db, userId, 6),
    buildWorkingMemoryContext(deps.db, userId),
  ]);
  // Internationalisation (m145): if the workspace turned on assistant localisation, ask the model to reply in
  // the reader's interface language. No-op otherwise (a skill already matches the language the user writes in).
  let streamLocaleInstruction = '';
  try {
    const prefs = await deps.db.getUserPreferences(userId) as { language?: string } | null;
    streamLocaleInstruction = await createI18nService(deps.db).assistantLocaleInstruction(tenantId, prefs?.language ?? null);
  } catch { /* i18n is best-effort; never block a reply */ }

  const streamContextParts: string[] = [];
  if (streamLocaleInstruction) streamContextParts.push(streamLocaleInstruction);
  if (streamSkillPrompt) streamContextParts.push(streamSkillPrompt);
  if (streamProceduralInstructions) streamContextParts.push(streamProceduralInstructions);
  if (streamWorkingMemoryContext) streamContextParts.push(streamWorkingMemoryContext);
  if (streamMemoryContext) streamContextParts.push(streamMemoryContext);
  if (streamEpisodicContext) streamContextParts.push(streamEpisodicContext);
  const streamAugmentedPrompt = streamContextParts.length > 0 ? streamContextParts.join('\n\n---\n') : undefined;
  const streamMemorySettings = {
    ...settings,
    enabledTools: streamEnabledTools,
    systemPrompt: streamAugmentedPrompt,
    skillPolicyKey: streamSkillPolicyKey,
    skillContributedTools: streamSkillTools,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const heartbeat = startSseHeartbeat(res);
  res.once('close', () => heartbeat.stop());

  if (redactionInfo) {
    await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
  }

  const startMs = Date.now();
  let fullText = '';
  let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let streamPromptCache: { readTokens: number; writeTokens: number; applied: boolean; ttl: '5m' | '1h' } | undefined;
  let steps: AgentStep[] = [];
  let toolCallEvents: ToolCallObservableEvent[] = [];
  let streamContractInfo: PromptContractValidationReport | undefined;
  let streamErrored = false;
  let streamErrorMessage: string | undefined;
  let streamTelemetry: AgentRunTelemetry | undefined;
  let ttftAborted = false;

  let ensembleMeta: { candidates: Array<{ agentName: string; output: string }>; rationale?: string; winner?: string } | undefined;

  try {
    if (settings.mode === 'agent' || settings.mode === 'supervisor' || settings.mode === 'ensemble') {
      streamTelemetry = await deps.streamAgent(res, ctx, model, userId, chatId, userPersona, messages, processedContent, streamMemorySettings, attachments, tenantId);
      fullText = streamTelemetry.result.output ?? '';
      // H-4: Use the actual prompt/completion split from AgentResult.usage so
      // the cost ledger records the correct per-direction token counts.
      finalUsage = {
        promptTokens: streamTelemetry.result.usage.promptTokens,
        completionTokens: streamTelemetry.result.usage.completionTokens,
        totalTokens: streamTelemetry.result.usage.totalTokens,
      };
      steps = [...streamTelemetry.result.steps];
      toolCallEvents = streamTelemetry.toolCallEvents;
      // Extract ensemble-specific fields when present
      const ensResult = streamTelemetry.result as any;
      if (Array.isArray(ensResult.candidates) && ensResult.candidates.length) {
        ensembleMeta = {
          candidates: ensResult.candidates.map((c: any) => ({ agentName: String(c.agentName ?? ''), output: String(c.output ?? '') })),
          rationale: ensResult.rationale ? String(ensResult.rationale) : undefined,
          winner: ensResult.winner ? String(ensResult.winner) : undefined,
        };
        await deps.writeSseEvent(res, { type: 'ensemble_result', ...ensembleMeta });
      }
    } else {
      // Phase 2: provider-native prompt caching on the streaming path — cache the
      // stable prefix (system prompt). Anthropic needs the explicit breakpoint;
      // OpenAI/Gemini cache implicitly and surface cached_tokens without a hint.
      const streamPlanPricing = (await deps.loadPricing()).get(modelId);
      const streamCachePlan = planPromptCacheBreakpoints({
        systemText: streamAugmentedPrompt ?? '',
        minTokens: streamPlanPricing?.promptCacheMinTokens ?? 1024,
        ttl: streamPlanPricing?.promptCacheTtl ?? '5m',
        enabled: streamPlanPricing?.promptCacheEnabled ?? true,
        providerSupported: provider === 'anthropic',
      });
      streamPromptCache = { readTokens: 0, writeTokens: 0, applied: streamCachePlan.enabled || provider === 'openai', ttl: streamCachePlan.ttl };

      // Reasoning request (m92): when the chat enabled reasoning AND the model is
      // reasoning-capable, ask the provider for reasoning (Anthropic thinking /
      // OpenAI effort). Gated on `supports_thinking` so we never send `thinking`
      // to a model that rejects it. The capability lookup only runs when enabled.
      const baseMaxTokens = opts?.maxTokens ?? 4096;
      let streamReasoningMeta: ReasoningRequestMetadata | undefined;
      if (settings.reasoningEnabled) {
        const caps = await deps.db.listCapabilityScores({ provider, modelId }).catch(() => []);
        streamReasoningMeta = buildReasoningRequestMetadata({
          provider,
          supportsThinking: caps.some((c) => c.supports_thinking === 1),
          enabled: true,
          effort: settings.reasoningEffort ?? null,
          budgetTokens: settings.reasoningBudgetTokens ?? null,
          maxTokens: baseMaxTokens,
        });
      }
      const streamMetadata: Record<string, unknown> = {};
      if (provider === 'openai') streamMetadata['promptCacheKey'] = `gw:${tenantId ?? 'global'}:${chatId}`;
      if (streamReasoningMeta?.thinking) streamMetadata['thinking'] = streamReasoningMeta.thinking;
      if (streamReasoningMeta?.reasoningEffort) streamMetadata['reasoningEffort'] = streamReasoningMeta.reasoningEffort;

      const request: ModelRequest = {
        messages: streamAugmentedPrompt
          ? [{ role: 'system' as const, content: streamAugmentedPrompt }, ...messages]
          : messages,
        maxTokens: reasoningAdjustedMaxTokens(streamReasoningMeta, baseMaxTokens),
        // Anthropic rejects a pinned temperature when thinking is enabled.
        temperature: reasoningAdjustedTemperature(streamReasoningMeta, opts?.temperature),
        stream: true,
        ...(streamCachePlan.enabled ? { promptCache: { ttl: streamCachePlan.ttl } } : {}),
        ...(Object.keys(streamMetadata).length ? { metadata: streamMetadata } : {}),
      };

      // Phase 1: OTel GenAI span covering the entire model interaction (streaming
      // or fallback non-streaming). The span starts before the first token and
      // ends when the last chunk arrives or an error is thrown.
      const llmSpan = ctx.runtime?.tracer?.startSpan(ctx, 'gen_ai.chat', {
        'gen_ai.system': provider,
        'gen_ai.request.model': modelId,
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.max_tokens': request.maxTokens,
        ...(request.temperature !== undefined ? { 'gen_ai.request.temperature': request.temperature } : {}),
      });

      if (model.stream) {
        // TTFT guard: if the provider doesn't emit any token within the budget,
        // abort and surface a clear "provider unresponsive" error rather than
        // silently waiting until the full deadline fires.
        let firstTokenReceived = false;
        const ttftTimer = setTimeout(() => {
          if (!firstTokenReceived) {
            ttftAborted = true;
            abortController.abort();
          }
        }, streamBudget.ttftMs);

        const stream = model.stream(ctx, request);
        try {
          for await (const chunk of stream) {
            if (!firstTokenReceived && (chunk.type === 'text' || chunk.type === 'reasoning')) {
              firstTokenReceived = true;
              clearTimeout(ttftTimer);
            }
            if (chunk.type === 'text' && chunk.text) {
              fullText += chunk.text;
              const delivered = await deps.writeSseEvent(res, { type: 'text', text: chunk.text });
              if (!delivered) {
                clientDisconnected = true;
                abortController.abort();
                break;
              }
            } else if (chunk.type === 'reasoning' && chunk.reasoning) {
              const delivered = await deps.writeSseEvent(res, { type: 'reasoning', text: chunk.reasoning });
              if (!delivered) {
                clientDisconnected = true;
                abortController.abort();
                break;
              }
            } else if (chunk.type === 'usage' && chunk.usage) {
              finalUsage = { promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens, totalTokens: chunk.usage.totalTokens };
              // Phase 2: accumulate provider prompt-cache token counts.
              if (streamPromptCache) {
                if (chunk.usage.cacheReadTokens) streamPromptCache.readTokens = chunk.usage.cacheReadTokens;
                if (chunk.usage.cacheWriteTokens) streamPromptCache.writeTokens = chunk.usage.cacheWriteTokens;
              }
              // Attach token counts to the OTel span once we have them
              llmSpan?.setAttribute('gen_ai.usage.input_tokens', finalUsage.promptTokens);
              llmSpan?.setAttribute('gen_ai.usage.output_tokens', finalUsage.completionTokens);
            } else if (chunk.type === 'done') {
              // Do NOT break here: some providers (OpenAI) emit the final usage
              // chunk *after* the finish-reason `done`. Breaking would drop the
              // token counts (and prompt-cache tokens). The generator ends on its
              // own when the provider closes the stream, so we drain to the end.
              continue;
            }
          }
        } finally {
          clearTimeout(ttftTimer);
          llmSpan?.end();
        }
      } else {
        const { result: response } = await withLLMSpan(
          ctx,
          { provider, modelId, operation: 'chat', maxTokens: request.maxTokens, temperature: request.temperature },
          () => model.generate(ctx, request),
        );
        llmSpan?.end(); // end the outer span too
        fullText = response.content;
        finalUsage = { ...response.usage };
        if (streamPromptCache) {
          streamPromptCache.readTokens = response.usage.cacheReadTokens ?? 0;
          streamPromptCache.writeTokens = response.usage.cacheWriteTokens ?? 0;
        }
        await deps.writeSseEvent(res, { type: 'text', text: response.content });
      }
    }
  } catch (err: unknown) {
    streamErrored = true;
    streamErrorMessage = ttftAborted
      ? `Provider did not start responding within ${streamBudget.ttftMs / 1000}s (time-to-first-token exceeded). Please retry.`
      : err instanceof Error ? err.message : 'Stream error';
    if (!clientDisconnected) {
      await deps.writeSseEvent(res, { type: 'error', error: streamErrorMessage });
    }
    // Phase 7 negative cache: remember the failure briefly so an immediate retry
    // storm of the identical request is shielded from the backend.
    if (streamNegTtlMs > 0) await writeNegativeCache(deps.responseCache, streamCacheKey, streamNegTtlMs);
    // Leader failed → let any followers fall through and recompute.
    sfLeader?.reject(err);
  }

  const latencyMs = Date.now() - startMs;
  const streamDbPricing = await deps.loadPricing();
  const cost = calculateCost(modelId, finalUsage.promptTokens, finalUsage.completionTokens, streamDbPricing.get(modelId));

  deps.recordModelOutcome(modelId, provider, latencyMs, !streamErrored && !clientDisconnected, streamErrored ? streamErrorMessage : undefined);

  // Phase 3: record observed cost into the runtime ledger for future budget checks.
  if (deps.config.runtime?.cost && cost > 0 && !streamErrored && !clientDisconnected) {
    deps.config.runtime.cost.record({
      userId, tenantId,
      model: modelId, provider,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      costUsd: cost,
    }).catch(() => {});
  }

  // Phase 5: feed token throughput into the adaptive budget tracker so future
  // calls can tighten deadlines to estimated_tokens × p50MsPerToken × 1.5.
  if (!streamErrored && !clientDisconnected && finalUsage.completionTokens > 0) {
    recordThroughput(`${provider}:rest`, latencyMs, finalUsage.completionTokens);
  }
  // Block the provider immediately on rate limit — account-level 429s apply to all models.
  if (streamErrored && streamErrorMessage && /rate.?limit|quota|too many requests|429/i.test(streamErrorMessage)) {
    deps.healthTracker.blockProvider(provider, 5 * 60_000);
  }

  if (clientDisconnected) {
    // M-27: The user disconnected before the stream completed, leaving `userMsgId`
    // in the database without a corresponding assistant turn. A bare user message
    // with no reply is an "orphaned half-turn" that confuses history UIs and any
    // memory system that expects alternating user/assistant pairs.
    //
    // Because there is no `deleteMessage` API, we close the turn by writing a
    // synthetic `[Stream cancelled]` assistant message. This keeps the chat
    // history internally consistent and makes the cancellation visible to the
    // user if they reload before the full response arrives in a later attempt.
    try {
      await deps.db.addMessage({
        id: newUUIDv7(),
        chatId,
        role: 'assistant',
        content: '[Stream cancelled] The connection was closed before the response was complete.',
        metadata: JSON.stringify({ streamCancelled: true, latencyMs: Date.now() - startMs }),
      });
    } catch {
      // Best-effort — if the DB write fails we still return cleanly.
    }
    return;
  }

  if (streamErrored && !fullText.trim()) {
    const isRateLimit = streamErrorMessage && /rate.?limit|quota|too many requests|429/i.test(streamErrorMessage);
    const errorContent = isRateLimit
      ? `[Rate limited] ${provider} is currently rate limited. Your next message will be automatically routed to an available provider. (${streamErrorMessage})`
      : `[Stream interrupted] ${streamErrorMessage || 'The model did not return a response.'} Please retry; if this persists, the request may exceed the model's context window or per-request timeout.`;
    await deps.writeSseEvent(res, { type: 'text', text: errorContent });
    await deps.writeSseEvent(res, {
      type: 'done',
      usage: finalUsage,
      cost,
      latencyMs,
      model: modelId,
      provider,
      mode: settings.mode,
      streamInterrupted: true,
      error: streamErrorMessage,
      traceId,
    });
    deps.endSse(res);
    // Persist a fallback assistant message so the user sees the failure in chat history
    // instead of a blank UI on reload. Without this, model timeouts and other stream
    // exceptions silently drop the turn.
    try {
      await deps.db.addMessage({
        id: newUUIDv7(),
        chatId,
        role: 'assistant',
        content: errorContent,
        metadata: JSON.stringify({
          model: modelId,
          provider,
          streamed: true,
          mode: settings.mode,
          streamInterrupted: true,
          error: streamErrorMessage,
          traceId,
        }),
        tokensUsed: finalUsage.totalTokens,
        cost,
        latencyMs,
      });
    } catch {
      // Best-effort persistence; never block the early return on a write failure.
    }
    return;
  }

  const policyChecks = steps.length ? await evaluateTaskPolicies(deps.db, steps) : undefined;
  if (policyChecks?.length) {
    await deps.writeSseEvent(res, { type: 'policy_checks', checks: policyChecks });
    if (deps.onPolicyChecks) {
      await deps.onPolicyChecks(userId, policyChecks).catch(() => {});
    }
  }

  if (!fullText.trim()) {
    const hadExecutionActivity = steps.length > 0;
    fullText = hadExecutionActivity
      ? 'I completed execution steps but could not produce a final response text. Please retry this request; if this repeats, check the trace for this run.'
      : 'I could not produce a response text for this request. Please retry.';
    await deps.writeSseEvent(res, { type: 'text', text: fullText });
  }

  // M-18: extracted to chat-message-utils.extractToolEvidence — shared with send path
  const streamToolEvidence = extractToolEvidence(steps);
  const postGuardrail = await evaluateGuardrails(deps.db, chatId, null, fullText, 'post-execution',
    { userInput: processedContent, assistantOutput: fullText, toolEvidence: streamToolEvidence },
    {
      persona: userPersona,
      chatMode: settings.mode,
      turnNumber,
      tenantId,
      steps,
      priorGuardrailResults: preGuardrail.results,
    },
  );
  if (postGuardrail.cognitive) {
    await deps.writeSseEvent(res, { type: 'cognitive', ...postGuardrail.cognitive });
  }
  if (postGuardrail.decision !== 'allow') {
    await deps.writeSseEvent(res, { type: 'guardrail', decision: postGuardrail.decision, reason: postGuardrail.reason });
  }

  const streamGuardrailDecision = postGuardrail.decision as 'allow' | 'warn' | 'deny';
  const evalResult = await runPostEval(deps.db, ctx, userId, chatId, processedContent, fullText, latencyMs, cost, streamGuardrailDecision);
  const evalInfo = 'error' in evalResult ? undefined : evalResult;
  const evalError = 'error' in evalResult ? evalResult.error : undefined;
  if (evalInfo) {
    await deps.writeSseEvent(res, { type: 'eval', ...evalInfo });
  } else if (evalError) {
    await deps.writeSseEvent(res, { type: 'eval_error', error: evalError });
  }

  streamContractInfo = await validatePromptContractsAgainstDb(fullText, deps.db);
  if (streamContractInfo) {
    await deps.writeSseEvent(res, { type: 'contracts', ...streamContractInfo });
  }

  const autoTitle = await maybeAutoTitleChat(deps.db, userId, chatId, content, fullText, model, ctx);

  // m77 Phase 1: Extract artifact references emitted during this turn so the UI
  // can render artifact cards without re-parsing all tool call steps.
  const artifactRefs: Array<{ artifactId: string; version: number; name: string; type: string; language?: string }> = [];
  for (const s of steps) {
    if (s.type === 'tool_call' && s.toolCall?.name === 'emit_artifact' && s.toolCall.result) {
      try {
        const r = JSON.parse(s.toolCall.result) as Record<string, unknown>;
        if (r['ok'] === true && typeof r['artifactId'] === 'string') {
          artifactRefs.push({
            artifactId: r['artifactId'],
            version: typeof r['version'] === 'number' ? r['version'] : 1,
            name: typeof r['name'] === 'string' ? r['name'] : '',
            type: typeof r['type'] === 'string' ? r['type'] : 'custom',
            language: typeof r['language'] === 'string' ? r['language'] : undefined,
          });
        }
      } catch { /* malformed result — skip */ }
    }
  }

  // Generate the assistant message id up-front so the `done` event can return it — the UI attaches it to
  // the just-streamed message so answer feedback (thumbs / tiered) can target it immediately (m137).
  const assistMsgId = newUUIDv7();
  await deps.writeSseEvent(res, {
    type: 'done',
    usage: finalUsage,
    cost,
    latencyMs,
    model: modelId,
    provider,
    mode: settings.mode,
    messageId: assistMsgId,
    taskKey: resolvedTaskKey ?? undefined,
    activeSkills: streamActiveSkills,
    skillTools: streamSkillTools,
    enabledTools: streamMemorySettings.enabledTools,
    skillPromptApplied: streamActiveSkills.length > 0,
    steps: steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })),
    cognitive: postGuardrail.cognitive,
    contracts: streamContractInfo,
    evalError,
    guardrailError: preGuardrail.error ?? postGuardrail.error,
    promptStrategy: resolvedSystemPrompt.strategy,
    promptResolution: resolvedSystemPrompt.resolution,
    streamInterrupted: streamErrored || undefined,
    title: autoTitle ?? undefined,
    traceId,
    cached: false,
    promptCache: streamPromptCache,
    ensembleCandidates: ensembleMeta?.candidates,
    ensembleWinner: ensembleMeta?.winner,
    artifactRefs: artifactRefs.length ? artifactRefs : undefined,
  });

  // Phase 7 stampede: the turn produced a final answer — resolve the in-flight
  // promise so any waiting followers replay it instead of calling the model.
  if (!streamErrored && fullText.trim().length > 0) sfLeader?.resolve(fullText);

  // Phase 1: write-through to the response cache so a subsequent identical turn
  // (this replica or another, when L2/Redis is enabled) is served from cache.
  // Same gates as the non-streaming path: determinism, output-secret bypass,
  // allow-only guardrail decision, and a non-empty, non-guard-failure answer.
  const streamCacheWritable =
    !!streamCachePolicy &&
    streamAllowCache &&
    !streamErrored &&
    postGuardrail.decision !== 'deny' &&
    isCacheableTemperature(streamCachePolicy!, opts?.temperature) &&
    fullText.trim().length > 0 &&
    !fullText.includes('[Execution guard failure]') &&
    !shouldBypassResponse(streamCachePolicy!, fullText);
  if (streamCacheWritable) {
    try {
      // Phase 7: SWR-aware write (sidecar timestamp + extended TTL when swr_ms>0).
      await writeResponseWithSwr(deps.responseCache, streamCacheKey, { content: fullText, usage: finalUsage }, { ttlMs: streamCachePolicy!.ttlMs, swrMs: streamSwrMs });
    } catch { /* cache write is best-effort — never fail the turn on a cache error */ }
    // Phase 4: also persist to the semantic cache so a paraphrase hits next time.
    await semanticStore(deps.semanticCache, streamSemanticCfg, processedContent, { content: fullText, usage: finalUsage }, tenantId, userId);
  }

  await deps.db.addMessage({
    id: assistMsgId, chatId, role: 'assistant', content: fullText,
    metadata: JSON.stringify({
      model: modelId, provider, streamed: true, mode: settings.mode,
      agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
      systemPromptSha256: streamTelemetry?.systemPromptSha256,
      enabledTools: streamMemorySettings.enabledTools.length ? streamMemorySettings.enabledTools : undefined,
      activeSkills: streamActiveSkills.length ? streamActiveSkills : undefined,
      skillTools: streamSkillTools.length ? streamSkillTools : undefined,
      skillPromptApplied: streamActiveSkills.length > 0 ? true : undefined,
      redactionEnabled: settings.redactionEnabled || undefined,
      steps: steps.length ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
      ensembleCandidates: ensembleMeta?.candidates,
      ensembleRationale: ensembleMeta?.rationale
        ? ensembleMeta.rationale.replace(/[^\x20-\x7E]/g, '').slice(0, 500) || undefined
        : undefined,
      ensembleWinner: ensembleMeta?.winner,
      eval: evalInfo,
      evalError,
      guardrail: postGuardrail.decision !== 'allow' ? { decision: postGuardrail.decision, reason: postGuardrail.reason } : undefined,
      guardrailError: preGuardrail.error ?? postGuardrail.error,
      cognitive: postGuardrail.cognitive,
      policyChecks: policyChecks?.length ? policyChecks : undefined,
      promptContracts: streamContractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
      streamInterrupted: streamErrored || undefined,
      traceId,
      artifactRefs: artifactRefs.length ? artifactRefs : undefined,
    }),
    tokensUsed: finalUsage.totalTokens, cost, latencyMs,
  });

  try {
    await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, fullText, tenantId ?? undefined);
    triggerConsolidationForUser(userId, chatId);
  } catch (memErr) {
    // L-16: Log memory save / consolidation failures so operators can detect
    // memory backend outages without impacting the stream success path.
    logger.warn('memory save / consolidation failed (stream)', { err: memErr instanceof Error ? memErr.message : String(memErr) });
  }

  if (await isAnalyticsAllowed(deps.consentManager, userId)) {
    await deps.db.recordMetric({
      id: newUUIDv7(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens, cost, latencyMs,
    });
  }

  // Phase 3: a response-cache miss (the LLM ran) on the streaming path, plus any
  // provider prompt-cache token savings observed on this turn.
  deps.recordCacheMetrics?.({
    responseHit: false,
    responseEligible: !!streamCachePolicy,
    promptCacheReadTokens: streamPromptCache?.readTokens ?? 0,
    promptCacheWriteTokens: streamPromptCache?.writeTokens ?? 0,
    provider,
    inputCostPer1M: streamDbPricing.get(modelId)?.input ?? 0,
  });

  await recordTraceSpans(
    deps.db,
    userId,
    chatId,
    assistMsgId,
    traceId,
    settings.mode,
    startMs,
    latencyMs,
    steps,
    toolCallEvents,
    buildCapabilityTelemetrySnapshots(
      settings.mode,
      resolvedSystemPrompt.telemetry,
      streamActiveSkills,
      streamMemorySettings.enabledTools,
    ),
    streamTelemetry?.systemPromptSha256,
  );

  deps.endSse(res);
}

// H-15: historyToMessages moved to chat-message-utils.ts — imported above
