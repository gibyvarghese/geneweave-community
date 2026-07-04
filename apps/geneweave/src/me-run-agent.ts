/**
 * Default `/api/me/runs` run-agent (SP3).
 *
 * Bridges the run executor to the platform agent loop: it resolves the
 * configured default model, runs `weaveAgent.runStream`, and translates the
 * agent's step events onto the executor's `MeRunEmitter` (text deltas,
 * tool invoked/completed). The executor owns run lifecycle + sequencing; this
 * function only produces domain output and honours `args.signal` cooperatively.
 *
 * Kept deliberately thin and free of the chat-specific pipeline (memory,
 * skills, guardrail judges) so it stays reusable across surfaces. Richer
 * per-surface behaviour can be layered by supplying a different `MeRunAgent`.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { weaveAgent } from '@weaveintel/agents';
import type { Message, CitationPayload } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import { webCitation, deduplicateCitations, tableWidget } from '@weaveintel/ui-primitives';
import type { ChatEngineConfig, ChatAttachment } from './chat-runtime.js';
import { getOrCreateModel } from './chat-runtime.js';
import type { RunFilePart } from '@weaveintel/core';
import type { ChatEngine } from './chat.js';
import type { DatabaseAdapter } from './db-types.js';
import type { MeRunAgent, MeRunEmitter } from './me-run-executor.js';
import { runApprovals } from './me-run-approvals.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are weaveIntel, a helpful, concise assistant. Answer the user clearly and directly.';

/** Pull the user prompt text out of the run start payload. */
function extractPrompt(input: Record<string, unknown>): string {
  const candidates = [input['text'], input['prompt'], input['content'], input['message']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return '';
}

/**
 * Phase 7 — read multimodal attachments from the run input. Accepts
 * `input.attachments` (or `input.files`) as `{ name, mediaType|mimeType,
 * dataBase64, url?, size? }`. Returns both the run-event file parts (for the
 * round-trip view model) and the `ChatAttachment[]` to hand the vision model.
 */
function extractAttachments(input: Record<string, unknown>): { fileParts: RunFilePart[]; attachments: ChatAttachment[] } {
  const raw = Array.isArray(input['attachments']) ? input['attachments']
    : Array.isArray(input['files']) ? input['files'] : [];
  const fileParts: RunFilePart[] = [];
  const attachments: ChatAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const mediaType = typeof r['mediaType'] === 'string' ? r['mediaType'] as string
      : typeof r['mimeType'] === 'string' ? r['mimeType'] as string : 'application/octet-stream';
    const name = typeof r['name'] === 'string' ? r['name'] as string : `attachment-${i + 1}`;
    const dataBase64 = typeof r['dataBase64'] === 'string' ? r['dataBase64'] as string : undefined;
    const url = typeof r['url'] === 'string' ? r['url'] as string : undefined;
    const size = typeof r['size'] === 'number' ? r['size'] as number
      : dataBase64 ? Math.floor(dataBase64.length * 0.75) : 0;
    const id = typeof r['id'] === 'string' ? r['id'] as string : `infile-${i + 1}`;
    fileParts.push({ id, mediaType, name, direction: 'input', ...(dataBase64 ? { dataBase64 } : {}), ...(url ? { url } : {}), size });
    // Only inline (base64) attachments can be handed to the vision model.
    if (dataBase64) attachments.push({ name, mimeType: mediaType, size, dataBase64 });
  }
  return { fileParts, attachments };
}

export function createDefaultMeRunAgent(config: ChatEngineConfig): MeRunAgent {
  return async (args, emit) => {
    const prompt = extractPrompt(args.input);
    if (!prompt) {
      await emit.text('No input was provided for this run.');
      return;
    }

    const provider = config.defaultProvider;
    const modelId = config.defaultModel;
    const providerCfg = config.providers[provider] ?? {};
    const model = await getOrCreateModel(provider, modelId, providerCfg);

    const agent = weaveAgent({
      model,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });

    const messages: Message[] = [{ role: 'user', content: prompt }];

    // Prefer streaming; fall back to a single generate when unavailable.
    if (agent.runStream) {
      for await (const ev of agent.runStream(args.ctx, { messages, goal: prompt })) {
        if (args.signal.aborted) return;
        switch (ev.type) {
          case 'text_chunk': {
            if (ev.text) await emit.text(ev.text);
            break;
          }
          case 'tool_start': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolInvoked(tc.name, tc.arguments);
            break;
          }
          case 'tool_end': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolCompleted(tc.name, tc.result);
            break;
          }
          default:
            break;
        }
      }
      return;
    }

    const result = await agent.run(args.ctx, { messages, goal: prompt });
    if (args.signal.aborted) return;
    if (result.output) await emit.text(result.output);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-parity run-agent: routes `/api/me/runs` through the SAME ChatEngine
// pipeline the web UI streams (memory, skills, tools, guardrails, redaction,
// cost governor, model routing). This guarantees that any DB-driven config
// change made on the web surface (mode, enabled tools, settings) applies to the
// mobile surface automatically — there is exactly one chat code path.
//
// The bridge works by handing `chatEngine.streamMessage` an in-process
// `ServerResponse` adapter that captures the SSE frames it writes and maps them
// onto the executor's `MeRunEmitter`. No HTTP socket is involved.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_MODES = new Set(['direct', 'agent', 'supervisor', 'ensemble']);

/**
 * Resolve the chat-engine mode for a mobile run. The mobile surface ships a
 * single presentation mode ("Assistant"), so unless the client explicitly
 * selects one of the real chat modes we default to `agent` — the capable,
 * tool-enabled mode (datetime, calculator, web_search, …). `direct` has no
 * tools, which is why a bare assistant could answer with a stale date.
 */
function resolveChatMode(metadata: Record<string, unknown> | undefined): string {
  const options = (metadata?.['options'] && typeof metadata['options'] === 'object')
    ? metadata['options'] as Record<string, unknown>
    : undefined;
  const raw = options?.['mode'] ?? metadata?.['mode'];
  if (typeof raw === 'string' && CHAT_MODES.has(raw)) return raw;
  return 'agent';
}

/**
 * Resolve reasoning-request intent from run metadata (m92). A run can ask for
 * provider reasoning via `metadata.reasoning: true`, `metadata.reasoningEffort:
 * 'low'|'medium'|'high'`, or `metadata.reasoningBudgetTokens`. Applied to the
 * chat settings; honoured only when the model is reasoning-capable.
 */
/**
 * Resolve HITL intent from run metadata (Phase 4). `metadata.hitl: true`
 * enables tool-approval gating; `metadata.hitlRequireAll` (default true when
 * hitl is on) makes every tool call require approval; `metadata.hitlTimeoutMs`
 * caps the wait (auto-reject on timeout).
 */
export function resolveHitl(metadata: Record<string, unknown> | undefined): {
  hitlEnabled?: boolean; hitlRequireAll?: boolean; hitlTimeoutMs?: number;
} {
  if (!metadata || metadata['hitl'] !== true) return {};
  const requireAll = metadata['hitlRequireAll'] !== false;
  const timeout = typeof metadata['hitlTimeoutMs'] === 'number' && metadata['hitlTimeoutMs'] > 0
    ? Math.trunc(metadata['hitlTimeoutMs']) : undefined;
  return { hitlEnabled: true, hitlRequireAll: requireAll, ...(timeout !== undefined ? { hitlTimeoutMs: timeout } : {}) };
}

export function resolveReasoning(metadata: Record<string, unknown> | undefined): {
  reasoningEnabled?: boolean; reasoningEffort?: string; reasoningBudgetTokens?: number;
} {
  if (!metadata) return {};
  const effortRaw = metadata['reasoningEffort'];
  const effort = (effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high') ? effortRaw : undefined;
  const budget = typeof metadata['reasoningBudgetTokens'] === 'number' ? Math.max(0, Math.trunc(metadata['reasoningBudgetTokens'])) : undefined;
  const enabled = metadata['reasoning'] === true || metadata['reasoningEnabled'] === true || effort !== undefined || (budget !== undefined && budget > 0);
  if (!enabled) return {};
  return { reasoningEnabled: true, ...(effort ? { reasoningEffort: effort } : {}), ...(budget !== undefined ? { reasoningBudgetTokens: budget } : {}) };
}

/**
 * Derive a stable, per-user chat id for conversation continuity. When the
 * client supplies an opaque conversation token we hash it together with the
 * user id so the same conversation maps to the same server-side chat across
 * turns, while making cross-user id collision/hijack impossible. With no token
 * we mint a fresh chat per run.
 */
function resolveChatId(userId: string, metadata: Record<string, unknown> | undefined): string {
  const token = (typeof metadata?.['chatId'] === 'string' && metadata['chatId'])
    ? metadata['chatId'] as string
    : (typeof metadata?.['conversationId'] === 'string' && metadata['conversationId'])
      ? metadata['conversationId'] as string
      : undefined;
  if (token) {
    const h = createHash('sha256').update(`${userId}:${token}`).digest('hex').slice(0, 28);
    return `mob_${h}`;
  }
  return newUUIDv7();
}

/** Short, human-readable chat title derived from the first user prompt. */
function deriveTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : (trimmed || 'New Chat');
}

/**
 * Production run-agent for `/api/me/runs`. Bridges a mobile run to the full
 * web chat pipeline via `chatEngine.streamMessage`, giving the mobile surface
 * complete feature parity with the web chat UI.
 */
export function createChatPipelineMeRunAgent(chatEngine: ChatEngine, db: DatabaseAdapter): MeRunAgent {
  return async (args, emit) => {
    const prompt = extractPrompt(args.input);
    if (!prompt) {
      await emit.text('No input was provided for this run.');
      return;
    }

    const mode = resolveChatMode(args.metadata);
    const chatId = resolveChatId(args.userId, args.metadata);

    // Ensure the chat row exists (mirrors the web "New Chat" creation) so
    // streamMessage can persist messages and enable multi-turn history.
    const existing = await db.getChat(chatId, args.userId);
    if (!existing) {
      await db.createChat({
        id: chatId,
        userId: args.userId,
        title: deriveTitle(prompt),
        model: chatEngine.modelConfig.defaultModel,
        provider: chatEngine.modelConfig.defaultProvider,
      });
    }
    // Phase 4: associate the run with its chat for the HITL approval coordinator.
    runApprovals.setRunChat(args.runId, chatId);

    // Keep the chat's mode in sync with the current selection (idempotent
    // upsert). With no enabled_tools override, the engine derives the tool set
    // from the mode policy — identical to the web behaviour. Reasoning + HITL
    // intent from the run metadata are applied here.
    await db.saveChatSettings({ chatId, mode, ...resolveReasoning(args.metadata), ...resolveHitl(args.metadata) });

    // Phase 7 — structured object streaming + multimodal attachments.
    const objectMode = args.metadata?.['objectMode'] === true;
    const { fileParts, attachments } = extractAttachments(args.input);
    // Echo input attachments into the run as file parts (the multimodal
    // round-trip) before the model output streams.
    for (const part of fileParts) await emit.file(part);

    const capture = new SseCaptureResponse(emit, objectMode);
    const onAbort = (): void => capture.cancel();
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener('abort', onAbort, { once: true });

    // A run may pin a specific model/provider (e.g. to force a reasoning model);
    // this bypasses the router inside the chat engine.
    const modelPin = typeof args.metadata?.['model'] === 'string' ? args.metadata['model'] as string : undefined;
    const providerPin = typeof args.metadata?.['provider'] === 'string' ? args.metadata['provider'] as string : undefined;
    try {
      await chatEngine.streamMessage(
        capture as unknown as ServerResponse,
        args.userId,
        chatId,
        prompt,
        {
          ...(modelPin ? { model: modelPin } : {}),
          ...(providerPin ? { provider: providerPin } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      );
      // Flush any queued emitter writes before the executor marks completion.
      await capture.drain();
    } finally {
      args.signal.removeEventListener('abort', onAbort);
    }

    if (capture.error) throw new Error(capture.error);
  };
}

/**
 * Minimal in-process `ServerResponse` stand-in. The ChatEngine writes SSE
 * frames (`data: {json}\n\n`) via `res.write`; we parse them and translate the
 * frame types the mobile run cares about onto the `MeRunEmitter`. Emitter calls
 * are serialized through a tail promise so ordering matches the stream.
 *
 * Only the surface the streaming pipeline actually touches is implemented:
 * `write`, `writeHead`, `end`, `writableEnded`, `destroyed`, plus the
 * EventEmitter `on/once/off/emit` used for `drain`/`close` backpressure.
 */
export class SseCaptureResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  /** Captured `error` frame text, surfaced to the executor as a run failure. */
  error: string | undefined;

  readonly #out: MeRunEmitter;
  #buf = '';
  #tail: Promise<void> = Promise.resolve();
  // Phase 2 — correlate tool_start ↔ tool_end. The chat frames carry only the
  // tool `name` (no id), so we assign a stable toolCallId on start and pop it on
  // end via a per-name stack (handles nested/parallel same-name calls in order).
  #toolSeq = 0;
  readonly #toolStack = new Map<string, string[]>();
  // Phase 7 — when objectMode is on, the assistant's text IS a streamed JSON
  // object: mirror each text frame to `object.delta` and finalize on `done`.
  readonly #objectMode: boolean;
  #objectStarted = false;

  constructor(out: MeRunEmitter, objectMode = false) {
    super();
    this.#out = out;
    this.#objectMode = objectMode;
  }

  writeHead(_status?: number, _headers?: unknown): this {
    return this;
  }

  write(chunk: string | Buffer): boolean {
    if (this.destroyed) return false;
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.#buf.indexOf('\n\n')) !== -1) {
      const frame = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 2);
      if (frame) this.#handleFrame(frame);
    }
    return true;
  }

  end(_chunk?: unknown): this {
    this.writableEnded = true;
    return this;
  }

  /** Cancel the underlying stream: notify the pipeline's `close` listener. */
  cancel(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  /** Resolve once every queued emitter write has been applied, in order. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  #handleFrame(frame: string): void {
    if (!frame.startsWith('data:')) return;
    const json = frame.slice(frame.indexOf(':') + 1).trim();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof payload['type'] === 'string' ? payload['type'] as string : '';
    switch (type) {
      case 'text': {
        const text = typeof payload['text'] === 'string' ? payload['text'] as string : '';
        if (text) {
          this.#enqueue(() => this.#out.text(text));
          // Phase 7: in object mode the text stream IS the JSON object.
          if (this.#objectMode) { this.#objectStarted = true; this.#enqueue(() => this.#out.objectDelta(text)); }
        }
        break;
      }
      case 'reasoning': {
        // Phase 1: a DISTINCT reasoning channel — no longer folded into text.
        const text = typeof payload['text'] === 'string' ? payload['text'] as string : '';
        if (text) this.#enqueue(() => this.#out.reasoning(text));
        break;
      }
      case 'tool_start': {
        const name = typeof payload['name'] === 'string' ? payload['name'] as string : '';
        const rawArgs = payload['arguments'];
        const toolArgs = (rawArgs && typeof rawArgs === 'object')
          ? rawArgs as Record<string, unknown>
          : undefined;
        if (!name) break;
        const id = `tc_${this.#toolSeq++}`;
        const stack = this.#toolStack.get(name) ?? [];
        stack.push(id);
        this.#toolStack.set(name, stack);
        // Args arrive complete here (no provider-level partial streaming yet) →
        // the tool part lands directly in `input-available`.
        this.#enqueue(() => this.#out.toolInvoked(name, toolArgs, id));
        break;
      }
      case 'tool_end': {
        const name = typeof payload['name'] === 'string' ? payload['name'] as string : '';
        if (!name) break;
        const id = this.#toolStack.get(name)?.pop() ?? `tc_${this.#toolSeq++}`;
        const result = payload['result'];
        // A real tool.errored path: a tool result shaped `{ error: <string> }`
        // is surfaced as a tool failure rather than a successful completion.
        const errText = (result && typeof result === 'object' && typeof (result as Record<string, unknown>)['error'] === 'string')
          ? (result as Record<string, string>)['error']
          : undefined;
        if (errText) this.#enqueue(() => this.#out.toolErrored(name, errText, id));
        else this.#enqueue(() => this.#out.toolCompleted(name, result, id));
        // Phase 3: derive citations + a results widget from search tool output.
        this.#emitSearchDerivatives(name, result);
        // F2: an explicit emit_widget tool result becomes a widget.update.
        this.#emitWidgetFromTool(name, result);
        break;
      }
      case 'step': {
        // Phase 1: agent / supervisor plan steps.
        const s = (payload['step'] && typeof payload['step'] === 'object')
          ? payload['step'] as Record<string, unknown>
          : undefined;
        if (!s) break;
        const tc = (s['toolCall'] && typeof s['toolCall'] === 'object') ? s['toolCall'] as Record<string, unknown> : undefined;
        const step = {
          ...(typeof s['index'] === 'number' ? { index: s['index'] as number } : {}),
          ...(typeof s['type'] === 'string' ? { type: s['type'] as string } : {}),
          ...(typeof s['content'] === 'string' ? { content: s['content'] as string } : {}),
          ...(typeof tc?.['name'] === 'string' ? { toolName: tc['name'] as string } : {}),
          ...(typeof s['durationMs'] === 'number' ? { durationMs: s['durationMs'] as number } : {}),
          ...(payload['phase'] === 'step_start' || payload['phase'] === 'step_end' ? { phase: payload['phase'] as 'step_start' | 'step_end' } : {}),
        };
        this.#enqueue(() => this.#out.step(step));
        break;
      }
      case 'done': {
        // Phase 1: the richest dropped payload — usage / cost / latency / model,
        // plus any artifact references the turn produced.
        const u = (payload['usage'] && typeof payload['usage'] === 'object') ? payload['usage'] as Record<string, unknown> : {};
        const usage = {
          ...(typeof u['promptTokens'] === 'number' ? { promptTokens: u['promptTokens'] as number } : {}),
          ...(typeof u['completionTokens'] === 'number' ? { completionTokens: u['completionTokens'] as number } : {}),
          ...(typeof u['totalTokens'] === 'number' ? { totalTokens: u['totalTokens'] as number } : {}),
          ...(typeof payload['cost'] === 'number' ? { costUsd: payload['cost'] as number } : {}),
          ...(typeof payload['latencyMs'] === 'number' ? { latencyMs: payload['latencyMs'] as number } : {}),
          ...(typeof payload['model'] === 'string' ? { model: payload['model'] as string } : {}),
          ...(typeof payload['provider'] === 'string' ? { provider: payload['provider'] as string } : {}),
          ...(typeof payload['mode'] === 'string' ? { mode: payload['mode'] as string } : {}),
        };
        this.#enqueue(() => this.#out.usage(usage));
        const refs = Array.isArray(payload['artifactRefs']) ? payload['artifactRefs'] : [];
        for (const raw of refs) {
          if (!raw || typeof raw !== 'object') continue;
          const r = raw as Record<string, unknown>;
          const id = typeof r['id'] === 'string' ? r['id'] : (typeof r['artifactId'] === 'string' ? r['artifactId'] as string : undefined);
          if (!id) continue;
          const artifact = {
            id,
            ...(typeof r['type'] === 'string' ? { type: r['type'] as string } : {}),
            ...(typeof r['title'] === 'string' ? { title: r['title'] as string } : (typeof r['name'] === 'string' ? { title: r['name'] as string } : {})),
            ...(typeof r['mimeType'] === 'string' ? { mimeType: r['mimeType'] as string } : (typeof r['mime_type'] === 'string' ? { mimeType: r['mime_type'] as string } : {})),
            ...(typeof r['url'] === 'string' ? { url: r['url'] as string } : {}),
          };
          this.#enqueue(() => this.#out.artifact(artifact));
        }
        // Phase 7: finalize the streamed structured object (reducer parses the
        // accumulated object.delta text into the final value).
        if (this.#objectMode && this.#objectStarted) this.#enqueue(() => this.#out.objectComplete());
        break;
      }
      case 'error': {
        this.error = typeof payload['error'] === 'string' ? payload['error'] as string : 'Run failed';
        break;
      }
      case 'guardrail':
      case 'policy_checks':
      case 'eval':
      case 'eval_error':
      case 'cognitive':
      case 'contracts':
      case 'ensemble_result': {
        // Phase 1: surface (rather than drop) non-output metadata as diagnostics.
        const { type: _t, ...data } = payload;
        this.#enqueue(() => this.#out.diagnostic(type, data));
        break;
      }
      default:
        // redaction / generation / screenshot remain internal — not mirrored.
        break;
    }
  }

  #enqueue(fn: () => Promise<void>): void {
    this.#tail = this.#tail.then(fn).catch(() => {
      // Emitter writes are best-effort; a failed append must not break the run.
    });
  }

  /**
   * F2 — autonomous generative UI. The `emit_widget` tool returns
   * `{ ok, widget: WidgetPayload }`; surface it as a `widget.update` event so the
   * client reconstructs a widget part.
   */
  #emitWidgetFromTool(toolName: string, rawResult: unknown): void {
    if (toolName !== 'emit_widget') return;
    let parsed: Record<string, unknown> | undefined;
    if (rawResult && typeof rawResult === 'object') parsed = rawResult as Record<string, unknown>;
    else if (typeof rawResult === 'string') { try { parsed = JSON.parse(rawResult) as Record<string, unknown>; } catch { return; } }
    if (!parsed || parsed['ok'] !== true) return;
    const widget = parsed['widget'];
    if (!widget || typeof widget !== 'object') return;
    const w = widget as Record<string, unknown>;
    const id = typeof w['id'] === 'string' ? w['id'] : `widget-${Date.now()}`;
    const schemaVersion = typeof w['schemaVersion'] === 'number' ? w['schemaVersion'] as number : undefined;
    this.#enqueue(() => this.#out.widget(id, w, schemaVersion));
  }

  /**
   * Phase 3 — generative UI + citations from a search tool result. `web_search`
   * returns `{ query, results: [{ title, url, snippet, source }] }`; we surface
   * each result as a citation (deduped) and the whole set as a table widget,
   * reusing the `@weaveintel/ui-primitives` builders. Bridge-only: no chat-
   * pipeline change, fully reconstructable by the client reducer.
   */
  #emitSearchDerivatives(toolName: string, rawResult: unknown): void {
    if (toolName !== 'web_search') return;
    let parsed: Record<string, unknown> | undefined;
    if (rawResult && typeof rawResult === 'object') parsed = rawResult as Record<string, unknown>;
    else if (typeof rawResult === 'string') { try { parsed = JSON.parse(rawResult) as Record<string, unknown>; } catch { return; } }
    if (!parsed) return;
    const results = parsed['results'];
    if (!Array.isArray(results) || results.length === 0) return;

    // ── Citations ──
    const citations: CitationPayload[] = [];
    for (const raw of results) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const url = typeof r['url'] === 'string' ? r['url'] : '';
      if (!url) continue;
      const source = typeof r['source'] === 'string' && r['source'] ? r['source'] : (typeof r['title'] === 'string' ? r['title'] as string : 'web');
      const text = typeof r['snippet'] === 'string' && r['snippet'] ? r['snippet'] as string : source;
      try { citations.push(webCitation(text, url, source)); } catch { /* malformed url — skip */ }
    }
    for (const c of deduplicateCitations(citations)) {
      const citation = { id: c.id, ...(c.text ? { text: c.text } : {}), ...(c.source ? { source: c.source } : {}), ...(c.url ? { url: c.url } : {}) };
      this.#enqueue(() => this.#out.citation(citation));
    }

    // ── Generative UI: a table widget of the results ──
    const rows = results.slice(0, 10)
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => [String(r['title'] ?? ''), String(r['source'] ?? ''), String(r['url'] ?? '')]);
    if (rows.length > 0) {
      const query = typeof parsed['query'] === 'string' ? parsed['query'] as string : '';
      const widget = tableWidget(`Search results${query ? `: ${query}` : ''}`.slice(0, 80), ['Title', 'Source', 'URL'], rows, { a11ySummary: `${rows.length} web search results` });
      this.#enqueue(() => this.#out.widget(widget.id, widget as unknown as Record<string, unknown>, widget.schemaVersion));
    }
  }
}
