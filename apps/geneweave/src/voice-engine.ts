/**
 * @weaveintel/geneweave — VoiceEngine
 *
 * Wires together:
 *   • @weaveintel/voice VoicePipeline (STT → LLM → TTS)
 *   • GeneWeave ChatEngine (full text agent stack — memory, tools, guardrails,
 *     cost governor, evals, contracts, a2a, supervisor/worker, workflows, etc.)
 *   • DatabaseAdapter (voice sessions + events persistence)
 *   • ws WebSocket server (real-time audio duplex)
 *
 * All text-agent capabilities are inherited automatically because VoicePipeline
 * delegates the LLM phase to ChatEngine.sendMessage().  The voice agent is not
 * a separate agent — it reuses the SAME chat conversation, so voice turns appear
 * in message history alongside text turns and share memory, tool state, and cost
 * tracking.
 *
 * Capability summary (identical to text agents unless noted):
 *   ✓ Memory (semantic, episodic, entity, working)
 *   ✓ All tools (agenda, code execution, web search, a2a, etc.)
 *   ✓ Guardrails (input/output, model-graded)
 *   ✓ Cost governor (all 9 levers)
 *   ✓ Evals + contracts
 *   ✓ Supervisor / worker / ensemble modes
 *   ✓ Workflows
 *   ✓ Observability (traces, spans, usage)
 *   ✓ Skills + prompt augmentation
 *   ✓ PII redaction
 *   ◈ STT + TTS via OpenAI (Whisper + tts-1) — voice-specific
 *   ◈ WebSocket real-time audio streaming — voice-specific
 *   ◈ REST turn endpoint (for non-WS clients) — voice-specific
 */

import { newUUIDv7, createLogger, weaveContext } from '@weaveintel/core';
import type { AudioModel, ToolRiskLevel } from '@weaveintel/core';

const logger = createLogger('voice-engine');
import type { IncomingMessage } from 'node:http';
import type { WebSocket as WsSocket } from 'ws';
import {
  VoicePipeline,
  VoiceWsHandler,
  VoiceRealtimeProxy,
  computeRealtimeCostUsd,
  type VoiceConfig,
  type VoiceTurnResult,
  type RealtimeTool,
} from '@weaveintel/voice';
import type { DatabaseAdapter, VoiceConfigCreate } from './db.js';
import type { VoiceSessionStatus } from './db-types/adapter-voice.js';
import { getOrCreateModel, settingsFromRow } from './chat.js';
import type { ToolRegistryOptions } from './tools.js';
import type { ChatEngine } from './chat.js';
import { resolveSystemPrompt } from './chat-system-prompt-utils.js';
import { buildMemoryContext, saveToMemory } from './chat-memory-utils.js';
import { createToolRegistry } from './tools.js';
import { DbToolPolicyResolver, DbToolRateLimiter } from './tool-policy-resolver.js';
import { DbToolAuditEmitter } from './tool-audit-emitter.js';
import { createTemporalStore } from './temporal-store.js';
import { evaluateGuardrails } from './chat-guardrail-eval-utils.js';

// ─── Risk-level gate ──────────────────────────────────────────

/** Ordered from least to most risky. */
const RISK_ORDER: ToolRiskLevel[] = [
  'read-only', 'write', 'external-side-effect', 'financial', 'destructive', 'privileged',
];

/**
 * Return true when toolRisk is at or below the max allowed level.
 * 'low'  → read-only only
 * 'medium' → write and below (excludes financial, destructive, privileged)
 * 'high'   → all tools
 */
function isAllowedRisk(toolRisk: string, maxAllowed: 'low' | 'medium' | 'high'): boolean {
  if (maxAllowed === 'high') return true;
  const toolIdx = RISK_ORDER.indexOf(toolRisk as ToolRiskLevel);
  const ceiling = maxAllowed === 'low'
    ? RISK_ORDER.indexOf('read-only')
    : RISK_ORDER.indexOf('write');
  if (toolIdx === -1) return true; // unknown risk passes through
  return toolIdx <= ceiling;
}

// ─── Config ───────────────────────────────────────────────────

export interface VoiceEngineOptions {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  audioModel: AudioModel;
  /** OpenAI API key — used for the Realtime API proxy */
  openaiApiKey: string;
  /** Default voice config applied when user has no saved preferences */
  defaultConfig?: Partial<VoiceConfig>;
}

// ─── Engine ───────────────────────────────────────────────────

export class VoiceEngine {
  private readonly db: DatabaseAdapter;
  private readonly chatEngine: ChatEngine;
  private readonly audioModel: AudioModel;
  private readonly defaultConfig: VoiceConfig;
  private readonly openaiApiKey: string;

  constructor(opts: VoiceEngineOptions) {
    this.db = opts.db;
    this.chatEngine = opts.chatEngine;
    this.audioModel = opts.audioModel;
    this.openaiApiKey = opts.openaiApiKey;
    this.defaultConfig = {
      sttProvider: 'openai',
      sttModel: 'whisper-1',
      sttLanguage: undefined,
      ttsProvider: 'openai',
      ttsModel: 'tts-1',
      ttsVoice: 'alloy',
      ttsSpeed: 1.0,
      ttsFormat: 'mp3',
      enabledTools: null,
      mode: 'agent',
      pipelineMode: 'chained',
      realtimeModel: 'gpt-realtime-2',
      ...opts.defaultConfig,
    };
  }

  // ── Config helpers ──────────────────────────────────────────

  async getOrCreateConfig(userId: string, tenantId?: string | null): Promise<VoiceConfig> {
    const row = await this.db.getVoiceConfig(userId);
    if (row) {
      return {
        sttProvider: row.stt_provider,
        sttModel: row.stt_model,
        sttLanguage: row.stt_language ?? undefined,
        ttsProvider: row.tts_provider,
        ttsModel: row.tts_model,
        ttsVoice: row.tts_voice,
        ttsSpeed: row.tts_speed,
        ttsFormat: row.tts_format,
        enabledTools: row.enabled_tools ? (JSON.parse(row.enabled_tools) as string[]) : null,
        mode: row.mode,
        guardrailPolicy: row.guardrail_policy ?? undefined,
        costPolicy: row.cost_policy ?? undefined,
        pipelineMode: (row.pipeline_mode as 'chained' | 'realtime') ?? 'chained',
        realtimeModel: row.realtime_model ?? 'gpt-realtime-2',
      };
    }
    // Seed defaults for first-time user
    const create: VoiceConfigCreate = {
      userId,
      tenantId: tenantId ?? null,
      sttProvider: this.defaultConfig.sttProvider,
      sttModel: this.defaultConfig.sttModel,
      sttLanguage: this.defaultConfig.sttLanguage ?? null,
      ttsProvider: this.defaultConfig.ttsProvider,
      ttsModel: this.defaultConfig.ttsModel,
      ttsVoice: this.defaultConfig.ttsVoice,
      ttsSpeed: this.defaultConfig.ttsSpeed,
      ttsFormat: this.defaultConfig.ttsFormat,
      enabledTools: this.defaultConfig.enabledTools ?? null,
      mode: this.defaultConfig.mode,
      pipelineMode: this.defaultConfig.pipelineMode ?? 'chained',
      realtimeModel: this.defaultConfig.realtimeModel ?? 'gpt-realtime-2',
    };
    await this.db.upsertVoiceConfig(create);
    return { ...this.defaultConfig };
  }

  async updateConfig(userId: string, patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
    // Ensure the row exists before updating; if it's a new user, seed defaults first.
    await this.getOrCreateConfig(userId);
    await this.db.updateVoiceConfig(userId, {
      sttProvider: patch.sttProvider,
      sttModel: patch.sttModel,
      // Only pass null-able fields when they were explicitly set in the patch
      sttLanguage: 'sttLanguage' in patch ? (patch.sttLanguage ?? null) : undefined,
      ttsProvider: patch.ttsProvider,
      ttsModel: patch.ttsModel,
      ttsVoice: patch.ttsVoice,
      ttsSpeed: patch.ttsSpeed,
      ttsFormat: patch.ttsFormat,
      enabledTools: 'enabledTools' in patch ? (patch.enabledTools ?? null) : undefined,
      mode: patch.mode,
      guardrailPolicy: 'guardrailPolicy' in patch ? (patch.guardrailPolicy ?? null) : undefined,
      costPolicy: 'costPolicy' in patch ? (patch.costPolicy ?? null) : undefined,
      pipelineMode: patch.pipelineMode,
      realtimeModel: patch.realtimeModel,
    });
    return this.getOrCreateConfig(userId);
  }

  // ── Session lifecycle ───────────────────────────────────────

  /**
   * Create a new voice session bound to an existing (or new) chat.
   * If chatId is omitted, a new chat is created automatically.
   */
  async createSession(opts: {
    userId: string;
    tenantId?: string | null;
    chatId?: string;
    configOverride?: Partial<VoiceConfig>;
  }): Promise<{ sessionId: string; chatId: string; config: VoiceConfig }> {
    const config = await this.getOrCreateConfig(opts.userId, opts.tenantId);

    // Apply per-session overrides
    const effective: VoiceConfig = { ...config, ...opts.configOverride };

    let chatId = opts.chatId;
    if (!chatId) {
      chatId = newUUIDv7();
      await this.db.createChat({
        id: chatId,
        userId: opts.userId,
        title: 'Voice Chat',
        model: this.chatEngine.modelConfig.defaultModel,
        provider: this.chatEngine.modelConfig.defaultProvider,
      });
    }

    // Apply voice mode settings to the chat
    await this.db.saveChatSettings({
      chatId,
      mode: effective.mode,
      enabledTools: effective.enabledTools ? JSON.stringify(effective.enabledTools) : undefined,
    });

    const sessionId = newUUIDv7();
    await this.db.createVoiceSession({
      id: sessionId,
      userId: opts.userId,
      tenantId: opts.tenantId ?? null,
      chatId,
      configSnapshot: JSON.stringify(effective),
    });

    // Audit: session_start
    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId,
      userId: opts.userId,
      turnIndex: 0,
      eventType: 'session_start',
    });

    return { sessionId, chatId, config: effective };
  }

  async endSession(sessionId: string, userId: string): Promise<void> {
    await this.db.endVoiceSession(sessionId, userId);
    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId,
      userId,
      turnIndex: -1,
      eventType: 'session_end',
    });
  }

  async getSession(sessionId: string, userId: string) {
    const row = await this.db.getVoiceSession(sessionId, userId);
    if (!row) return null;
    return {
      ...row,
      config: JSON.parse(row.config_snapshot) as VoiceConfig,
    };
  }

  async listSessions(userId: string, filter?: { status?: VoiceSessionStatus; limit?: number }) {
    return this.db.listVoiceSessions(userId, filter);
  }

  /**
   * weaveNotes Phase 4 — DETAILED transcription for meeting/voice capture: returns the text PLUS
   * timestamped segments (so summary points can anchor to the moment they were said). Uses the same
   * audio model as the voice agent; falls back to text-only (one segment) if the provider lacks the
   * detailed method. Owner-scoped (the caller passes the authenticated user).
   */
  async transcribeDetailed(input: { audio: Buffer; mimeType?: string; language?: string; model?: string }): Promise<import('@weaveintel/core').TranscriptionResult> {
    const ctx = weaveContext({ deadline: Date.now() + 180_000 });
    const req = {
      audio: input.audio,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.model ? { model: input.model } : {}),
      segments: true as const,
    };
    if (this.audioModel.transcribeDetailed) return this.audioModel.transcribeDetailed(ctx, req);
    const text = this.audioModel.transcribe ? await this.audioModel.transcribe(ctx, req) : '';
    return { text, segments: text.trim() ? [{ start: 0, end: 0, text: text.trim() }] : [] };
  }

  // ── REST turn processing ────────────────────────────────────

  /**
   * Process one voice turn over REST (no WebSocket).
   * Client POSTs audio bytes; response includes transcript + LLM text + TTS audio.
   */
  async processTurnRest(opts: {
    sessionId: string;
    userId: string;
    audio: Buffer;
    mimeType?: string;
    textOverride?: string;
  }): Promise<VoiceTurnResult> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) throw new Error(`Voice session ${opts.sessionId} not found`);
    if (row.status === 'ended') throw new Error('Voice session has ended');
    if (row.status === 'error') throw new Error('Voice session is in error state');

    const config = JSON.parse(row.config_snapshot) as VoiceConfig;
    const pipeline = this.buildPipeline(opts.userId, config);

    const turnIndex = row.total_turns;
    const t0 = Date.now();

    const result = await pipeline.processTurn(
      opts.sessionId,
      turnIndex,
      opts.userId,
      row.chat_id,
      config,
      { audio: opts.audio, mimeType: opts.mimeType, textOverride: opts.textOverride },
      weaveContext({ deadline: Date.now() + 120_000 }),
    );

    const durationMs = Date.now() - t0;

    // Persist stats + audit event
    await this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, {
      turns: 1,
      sttMs: result.sttMs,
      llmMs: result.llmMs,
      ttsMs: result.ttsMs,
      costUsd: result.costUsd,
      audioBytes: opts.audio.length + result.responseAudio.length,
      lastActiveAt: new Date().toISOString(),
    });

    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId: opts.sessionId,
      userId: opts.userId,
      turnIndex,
      eventType: 'llm',
      inputText: result.transcript.slice(0, 4000),
      outputText: result.responseText.slice(0, 4000),
      audioBytesIn: opts.audio.length,
      audioBytesOut: result.responseAudio.length,
      sttProvider: config.sttProvider,
      sttModel: config.sttModel,
      ttsProvider: config.ttsProvider,
      ttsModel: config.ttsModel,
      ttsVoice: config.ttsVoice,
      llmProvider: result.llmProvider,
      llmModel: result.llmModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
      costUsd: result.costUsd,
      error: null,
      guardrailDecision: result.guardrailDecision,
      traceId: result.traceId ?? null,
    });

    return result;
  }

  // ── WebSocket session ───────────────────────────────────────

  /**
   * Accept a WebSocket upgrade and attach a VoiceWsHandler.
   * The handler manages the full real-time audio duplex session.
   */
  async handleWebSocket(opts: {
    sessionId: string;
    userId: string;
    ws: WsSocket;
    req: IncomingMessage;
  }): Promise<VoiceWsHandler> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) {
      opts.ws.close(4004, 'session not found');
      throw new Error(`Voice session ${opts.sessionId} not found`);
    }
    if (row.status === 'ended') {
      opts.ws.close(4010, 'session ended');
      throw new Error('Voice session has ended');
    }

    const config = JSON.parse(row.config_snapshot) as VoiceConfig;
    const pipeline = this.buildPipeline(opts.userId, config);

    // Map VoiceSessionRow to VoiceSession shape expected by VoiceWsHandler
    const session = {
      id: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      chatId: row.chat_id,
      status: row.status as 'active' | 'paused' | 'ended' | 'error',
      config,
      totalTurns: row.total_turns,
      totalSttMs: row.total_stt_ms,
      totalTtsMs: row.total_tts_ms,
      totalLlmMs: row.total_llm_ms,
      totalCostUsd: row.total_cost_usd,
      totalAudioBytes: row.total_audio_bytes,
      wsConnected: row.ws_connected === 1,
      lastActiveAt: row.last_active_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const handler = new VoiceWsHandler({
      session,
      ws: opts.ws,
      pipeline,
      callbacks: {
        onConnectionChange: async (sid, connected) => {
          await this.db.updateVoiceSessionStats(sid, opts.userId, { wsConnected: connected });
        },
        onTurnComplete: async (sid, turnResult) => {
          await this.db.updateVoiceSessionStats(sid, opts.userId, {
            turns: 1,
            sttMs: turnResult.sttMs,
            llmMs: turnResult.llmMs,
            ttsMs: turnResult.ttsMs,
            costUsd: turnResult.costUsd,
            audioBytes: turnResult.audioBytesIn + turnResult.audioBytesOut,
            lastActiveAt: new Date().toISOString(),
          });
          await this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: sid,
            userId: opts.userId,
            turnIndex: turnResult.turnIndex,
            eventType: turnResult.error ? 'error' : 'llm',
            inputText: turnResult.transcript?.slice(0, 4000) ?? null,
            outputText: turnResult.responseText?.slice(0, 4000) ?? null,
            audioBytesIn: turnResult.audioBytesIn,
            audioBytesOut: turnResult.audioBytesOut,
            sttProvider: config.sttProvider,
            sttModel: config.sttModel,
            ttsProvider: config.ttsProvider,
            ttsModel: config.ttsModel,
            ttsVoice: config.ttsVoice,
            llmProvider: turnResult.llmProvider,
            llmModel: turnResult.llmModel,
            promptTokens: turnResult.promptTokens,
            completionTokens: turnResult.completionTokens,
            durationMs: turnResult.sttMs + turnResult.llmMs + turnResult.ttsMs,
            costUsd: turnResult.costUsd,
            error: turnResult.error?.slice(0, 500) ?? null,
            guardrailDecision: turnResult.guardrailDecision,
            traceId: turnResult.traceId ?? null,
          });
        },
        onSessionEnd: async (sid) => {
          await this.db.endVoiceSession(sid, opts.userId);
          await this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: sid,
            userId: opts.userId,
            turnIndex: -1,
            eventType: 'session_end',
          });
        },
      },
    });

    await handler.start();
    return handler;
  }

  // ── Realtime WebSocket proxy ────────────────────────────────

  /**
   * Accept a WebSocket upgrade for the OpenAI Realtime API proxy.
   * Path: /api/voice/sessions/:sessionId/realtime
   *
   * Phase 2 additions:
   *   • Resolves the real system prompt from chat settings (not a hard-coded generic)
   *   • Injects long-term memory context into the system prompt at session start
   *   • Saves each completed turn to memory (episodic + semantic extraction)
   *   • Rotates the upstream OpenAI session every N turns (default 8) with a
   *     freshly rebuilt system prompt so context-window latency doesn't drift
   */
  async handleRealtimeWebSocket(opts: {
    sessionId: string;
    userId: string;
    ws: WsSocket;
  }): Promise<void> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) {
      opts.ws.close(4004, 'session not found');
      return;
    }
    if (row.status === 'ended') {
      opts.ws.close(4010, 'session ended');
      return;
    }

    const config = JSON.parse(row.config_snapshot) as VoiceConfig;
    const realtimeModel = config.realtimeModel ?? 'gpt-realtime-2';
    const voice         = config.ttsVoice ?? 'alloy';
    const chatId        = row.chat_id;
    const userId        = opts.userId;
    const rotateAfter             = config.realtimeSessionRotateAfterTurns ?? 8;
    const toolBudgetMs            = config.realtimeToolBudgetMs ?? 800;
    const maxToolRisk             = config.realtimeMaxAutoToolRisk ?? 'low';
    const inputGuardrailsEnabled  = config.realtimeInputGuardrails  ?? true;
    const outputGuardrailsEnabled = config.realtimeOutputGuardrails ?? true;

    // ── Resolve system prompt + memory context ────────────────

    const buildSystemPromptWithMemory = async (queryHint: string): Promise<string> => {
      // 1. Resolve system prompt from chat settings (same path as text agents)
      const chatSettings = settingsFromRow(await this.db.getChatSettings(chatId));
      const resolved     = await resolveSystemPrompt(this.db, chatSettings);

      const basePrompt = resolved.content
        ?? 'You are a helpful voice assistant. Keep responses concise and conversational. Speak naturally — avoid markdown, bullet points, and code blocks since the user hears your response as audio.';

      // 2. Build memory context (entity facts + semantic memories)
      let memoryBlock: string | null = null;
      try {
        const cfg = this.chatEngine.modelConfig;
        const defaultProvider = cfg.defaultProvider;
        const providerCfg     = cfg.providers[defaultProvider];
        if (providerCfg) {
          const memModel = await getOrCreateModel(defaultProvider, cfg.defaultModel, providerCfg);
          const memCtx   = weaveContext({ deadline: Date.now() + 10_000 });
          memoryBlock = await buildMemoryContext(this.db, memCtx, memModel, userId, queryHint);
        }
      } catch (err) {
        logger.warn('memory context build failed — proceeding without memory', { err });
      }

      if (memoryBlock) {
        return `${basePrompt}\n\n${memoryBlock}`;
      }
      return basePrompt;
    };

    const systemPrompt = await buildSystemPromptWithMemory(
      'voice conversation context preferences user background',
    );
    logger.info('voice-realtime session started', { sessionId: opts.sessionId, promptLen: systemPrompt.length, memoryInjected: systemPrompt.includes('\n\n'), rotateAfter });

    // ── Build voice tool registry (Phase 3) ───────────────────
    //
    // Tools are filtered by realtimeMaxAutoToolRisk (default 'low' = read-only).
    // Only tools that pass the risk gate are exposed to the OpenAI session.
    // The full policy-enforced registry is used for invocation so audit,
    // rate-limiting, and approval gates still apply even in voice sessions.

    const chatSettings = settingsFromRow(await this.db.getChatSettings(chatId));
    const enabledToolNames: string[] = chatSettings.enabledTools ?? [];

    const voiceToolOptions: ToolRegistryOptions = {
      temporalStore:    createTemporalStore(this.db),
      policyResolver:   new DbToolPolicyResolver(this.db),
      rateLimiter:      new DbToolRateLimiter(this.db),
      auditEmitter:     new DbToolAuditEmitter(this.db),
      currentUserId:    userId,
      currentChatId:    chatId,
      actorPersona:     'agent',
      explicitEnabledTools: enabledToolNames.length > 0 ? enabledToolNames : undefined,
      credentialResolver: (id: string) => this.db.getToolCredential(id),
    };

    // Build registry from the enabled tool names (empty = no tools).
    const voiceToolRegistry = enabledToolNames.length > 0
      ? await createToolRegistry(enabledToolNames, undefined, voiceToolOptions)
      : null;

    // Convert to RealtimeTool format, filtering by risk level.
    const realtimeTools: RealtimeTool[] = voiceToolRegistry
      ? voiceToolRegistry.list()
          .filter((tool) => isAllowedRisk(tool.schema.riskLevel ?? 'read-only', maxToolRisk))
          .map((tool) => ({
            name:        tool.schema.name,
            description: tool.schema.description,
            parameters:  tool.schema.parameters as Record<string, unknown>,
          }))
      : [];

    logger.info('voice-realtime tools configured', { sessionId: opts.sessionId, toolCount: realtimeTools.length, maxToolRisk, toolBudgetMs, tools: realtimeTools.map((t) => t.name).join(', ') || 'none' });
    logger.info('voice-realtime guardrails', { sessionId: opts.sessionId, inputGuardrailsEnabled, outputGuardrailsEnabled });

    await this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, {
      wsConnected: true,
      lastActiveAt: new Date().toISOString(),
    });

    // ── Per-turn state (captured in callbacks) ────────────────

    let turnIndex     = row.total_turns;
    let lastTranscript   = '';
    let lastResponseText = '';

    const proxy = new VoiceRealtimeProxy();

    proxy.start({
      clientWs: opts.ws,
      apiKey:   this.openaiApiKey,
      model:    realtimeModel,
      voice,
      systemPrompt,
      tools:        realtimeTools.length > 0 ? realtimeTools : undefined,
      toolBudgetMs,
      rotateAfterTurns: rotateAfter,
      callbacks: {

        onTranscript: (text) => {
          lastTranscript = text;
          void this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: opts.sessionId,
            userId,
            turnIndex,
            eventType: 'stt',
            inputText: text.slice(0, 4000),
            sttProvider: 'openai',
            sttModel: 'whisper-1',
          });
        },

        onResponseText: (text) => {
          lastResponseText = text;
          void this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: opts.sessionId,
            userId,
            turnIndex,
            eventType: 'llm',
            outputText: text.slice(0, 4000),
            llmProvider: 'openai',
            llmModel: realtimeModel,
          });
          turnIndex++;
        },

        onTurnComplete: (durationMs, usage) => {
          // Phase 5: use the shared computeRealtimeCostUsd helper which
          // correctly handles cached vs uncached audio tokens, text I/O, etc.
          const costUsd = usage ? computeRealtimeCostUsd(usage) : 0;

          void this.db.updateVoiceSessionStats(opts.sessionId, userId, {
            turns: 1,
            lastActiveAt: new Date().toISOString(),
            llmMs: durationMs,
            costUsd,
          });

          // Save this turn to memory (episodic + entity + semantic extraction)
          if (lastTranscript || lastResponseText) {
            const capturedTranscript   = lastTranscript;
            const capturedResponseText = lastResponseText;
            lastTranscript   = '';
            lastResponseText = '';

            const cfg = this.chatEngine.modelConfig;
            const defaultProvider = cfg.defaultProvider;
            const providerCfg     = cfg.providers[defaultProvider];
            if (providerCfg) {
              void getOrCreateModel(defaultProvider, cfg.defaultModel, providerCfg).then((memModel) => {
                const memCtx = weaveContext({ deadline: Date.now() + 30_000 });
                return saveToMemory(
                  this.db, memCtx, memModel,
                  userId, chatId,
                  capturedTranscript, capturedResponseText,
                  row.tenant_id ?? undefined,
                );
              }).catch((err) => {
                logger.warn('saveToMemory failed (non-critical)', { err });
              });
            }
          }
        },

        onEnd: () => {
          void this.db.updateVoiceSessionStats(opts.sessionId, userId, { wsConnected: false });
        },

        onRotateSession: async (turnCount, lastTurnTranscript) => {
          logger.info('rotating voice-realtime session', { turnCount, sessionId: opts.sessionId });
          const query = lastTurnTranscript.trim()
            ? lastTurnTranscript.slice(0, 300)
            : 'voice conversation context preferences user background';
          const newPrompt = await buildSystemPromptWithMemory(query);
          // Pass the same tool list into the rotated session.
          return { systemPrompt: newPrompt, tools: realtimeTools.length > 0 ? realtimeTools : undefined };
        },

        // ── Phase 4: Guardrails ──────────────────────────────────
        //
        // Input guardrail: fired on user speech transcript.  Fast checks
        // (regex, embedding) run synchronously before the model generates
        // audio; slow model-graded checks may fire after audio starts (the
        // proxy cancels the in-flight response on deny).
        //
        // Output guardrail: fired after the full response transcript is
        // available.  Audio has already streamed — deny removes the response
        // from model context and notifies the client.  Fail open on errors.
        onInputGuardrail: inputGuardrailsEnabled
          ? async (transcript) => {
              try {
                const gr = await evaluateGuardrails(
                  this.db,
                  chatId,
                  null,
                  transcript,
                  'pre-execution',
                  { userInput: transcript },
                  {
                    chatMode: 'direct',
                    turnNumber: turnIndex,
                    budgetMs: 3_000, // cap guardrail evaluation to 3s
                  },
                );
                return { decision: gr.decision, reason: gr.reason };
              } catch (err) {
                logger.warn('input guardrail error — failing open', { err });
                return { decision: 'allow' as const };
              }
            }
          : undefined,

        onOutputGuardrail: outputGuardrailsEnabled
          ? async (transcript) => {
              try {
                const gr = await evaluateGuardrails(
                  this.db,
                  chatId,
                  null,
                  transcript,
                  'post-execution',
                  { userInput: lastTranscript, assistantOutput: transcript },
                  {
                    chatMode: 'direct',
                    turnNumber: turnIndex,
                    budgetMs: 3_000,
                  },
                );
                return { decision: gr.decision, reason: gr.reason };
              } catch (err) {
                logger.warn('output guardrail error — failing open', { err });
                return { decision: 'allow' as const };
              }
            }
          : undefined,

        // ── Phase 3: Tool execution ──────────────────────────────
        onToolCall: voiceToolRegistry
          ? async (call) => {
              const tool = voiceToolRegistry.get(call.name);
              if (!tool) {
                return JSON.stringify({ error: `Tool '${call.name}' is not available in this voice session.` });
              }

              let args: Record<string, unknown>;
              try {
                args = JSON.parse(call.arguments) as Record<string, unknown>;
              } catch {
                return JSON.stringify({ error: `Invalid arguments for tool '${call.name}' — not valid JSON.` });
              }

              const ctx = weaveContext({ deadline: Date.now() + (toolBudgetMs > 0 ? toolBudgetMs * 2 : 30_000) });
              let result: import('@weaveintel/core').ToolOutput;
              try {
                result = await tool.invoke(ctx, { name: call.name, arguments: args });
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Unknown tool error.';
                logger.warn(`tool '${call.name}' threw`, { msg });
                result = { content: JSON.stringify({ error: msg }), isError: true };
              }

              // Persist tool call as a voice session event (non-blocking).
              // Use 'llm' eventType (closest semantic fit in the current schema).
              void this.db.insertVoiceSessionEvent({
                id:        newUUIDv7(),
                sessionId: opts.sessionId,
                userId,
                turnIndex,
                eventType:  'llm',
                inputText:  `[tool:${call.name}] ${call.arguments.slice(0, 900)}`,
                outputText: result.content.slice(0, 2000),
              });

              return result.isError
                ? JSON.stringify({ error: result.content })
                : result.content;
            }
          : undefined,
      },
    });
  }

  // ── Internal ────────────────────────────────────────────────

  private buildPipeline(userId: string, _config: VoiceConfig): VoicePipeline {
    const self = this;
    return new VoicePipeline({
      audioModel: this.audioModel,
      sender: {
        async send(opts) {
          // Delegate to the full text agent stack — inherits all capabilities:
          // memory, tools, guardrails, cost governor, evals, contracts, a2a, workflows…
          const result = await self.chatEngine.sendMessage(
            opts.userId,
            opts.chatId,
            opts.content,
          );
          const guardrailDecision = result.guardrail?.decision ?? 'allow';
          return {
            assistantContent: result.assistantContent ?? '',
            guardrailDecision: guardrailDecision as 'allow' | 'warn' | 'deny',
            provider: result.routingDecision?.provider ?? '',
            model: result.routingDecision?.model ?? '',
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            costUsd: result.cost,
            traceId: result.traceId,
          };
        },
      },
    });
  }
}

// ─── Factory helper ───────────────────────────────────────────

/**
 * Build and return a VoiceEngine from the geneWeave ChatEngine config.
 * Returns null when no OpenAI API key is configured (audio requires OpenAI).
 */
export async function createVoiceEngine(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  providers: Record<string, { apiKey?: string }>,
): Promise<VoiceEngine | null> {
  const openaiKey = providers['openai']?.apiKey;
  if (!openaiKey) {
    logger.warn('OpenAI API key not configured — voice agent disabled. Set OPENAI_API_KEY to enable.');
    return null;
  }

  const { weaveOpenAIAudio } = await import('@weaveintel/provider-openai');
  const audioModel = weaveOpenAIAudio({ apiKey: openaiKey });

  return new VoiceEngine({ db, chatEngine, audioModel, openaiApiKey: openaiKey });
}
