/**
 * @weaveintel/geneweave — Voice agent API routes
 *
 * REST endpoints:
 *   POST   /api/voice/config               — upsert per-user voice preferences
 *   GET    /api/voice/config               — get current config
 *   POST   /api/voice/sessions             — create voice session (optionally tied to a chat)
 *   GET    /api/voice/sessions             — list user's voice sessions
 *   GET    /api/voice/sessions/:id         — get session state + stats
 *   DELETE /api/voice/sessions/:id         — end a session
 *   POST   /api/voice/sessions/:id/turn    — REST turn: upload audio → get transcript+LLM+audio
 *   GET    /api/voice/sessions/:id/events  — audit log for a session
 *
 * WebSocket (handled via server.ts `upgrade` event, not this router):
 *   WS     /api/voice/sessions/:id/ws      — real-time audio duplex
 *
 * All endpoints require auth (JWT Bearer) and CSRF for mutations.
 * Audio uploads use multipart/form-data or raw binary POST with
 * Content-Type: audio/*.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VoiceEngine } from '../voice-engine.js';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { safePageInt } from './index.js';

const VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (OpenAI Whisper limit)

export function registerVoiceRoutes(
  router: Router,
  _db: DatabaseAdapter,
  voiceEngine: VoiceEngine,
): void {

  // ── Voice config ────────────────────────────────────────────

  router.get('/api/voice/config', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const config = await voiceEngine.getOrCreateConfig(auth.userId, auth.tenantId ?? null);
    json(res, 200, { config });
  });

  router.post('/api/voice/config', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const allowed = new Set(['sttProvider','sttModel','sttLanguage','ttsProvider','ttsModel','ttsVoice','ttsSpeed','ttsFormat','enabledTools','mode','pipelineMode','realtimeModel']);
    const patch: Record<string, unknown> = {};
    for (const k of allowed) { if (k in body) patch[k] = body[k]; }

    // Validate ttsVoice
    if (patch['ttsVoice'] && !['alloy','echo','fable','onyx','nova','shimmer'].includes(patch['ttsVoice'] as string)) {
      json(res, 400, { error: 'ttsVoice must be one of: alloy, echo, fable, onyx, nova, shimmer' }); return;
    }
    // Validate ttsFormat
    if (patch['ttsFormat'] && !['mp3','opus','aac','flac','wav','pcm'].includes(patch['ttsFormat'] as string)) {
      json(res, 400, { error: 'ttsFormat must be one of: mp3, opus, aac, flac, wav, pcm' }); return;
    }
    // Validate ttsSpeed
    if (patch['ttsSpeed'] !== undefined) {
      const s = Number(patch['ttsSpeed']);
      if (!Number.isFinite(s) || s < 0.25 || s > 4.0) {
        json(res, 400, { error: 'ttsSpeed must be 0.25–4.0' }); return;
      }
      patch['ttsSpeed'] = s;
    }
    // Validate mode
    if (patch['mode'] && !['agent','direct','supervisor'].includes(patch['mode'] as string)) {
      json(res, 400, { error: 'mode must be agent | direct | supervisor' }); return;
    }
    // Validate pipelineMode
    if (patch['pipelineMode'] && !['chained','realtime'].includes(patch['pipelineMode'] as string)) {
      json(res, 400, { error: 'pipelineMode must be chained | realtime' }); return;
    }

    const config = await voiceEngine.updateConfig(auth.userId, patch as Parameters<typeof voiceEngine.updateConfig>[1]);
    console.log(`[voice] config saved for ${auth.userId}: pipelineMode=${config.pipelineMode}`);
    json(res, 200, { config });
  }, { auth: true, csrf: true });

  // ── Sessions ────────────────────────────────────────────────

  router.post('/api/voice/sessions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { chatId?: string; configOverride?: Record<string, unknown> } = {};
    try { body = JSON.parse(raw); } catch { /* use defaults */ }

    const { sessionId, chatId, config } = await voiceEngine.createSession({
      userId: auth.userId,
      tenantId: auth.tenantId ?? null,
      chatId: body.chatId,
      configOverride: body.configOverride as Parameters<typeof voiceEngine.createSession>[0]['configOverride'],
    });

    json(res, 201, { sessionId, chatId, config });
  }, { auth: true, csrf: true });

  router.get('/api/voice/sessions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const status = url.searchParams.get('status') as 'active' | 'ended' | null;
    const limit = safePageInt(url.searchParams.get('limit'), 20, 1, 100);
    const sessions = await voiceEngine.listSessions(auth.userId, { status: status ?? undefined, limit });
    json(res, 200, { sessions });
  });

  router.get('/api/voice/sessions/:sessionId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const session = await voiceEngine.getSession(params['sessionId']!, auth.userId);
    if (!session) { json(res, 404, { error: 'Session not found' }); return; }
    json(res, 200, { session });
  });

  router.del('/api/voice/sessions/:sessionId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const session = await voiceEngine.getSession(params['sessionId']!, auth.userId);
    if (!session) { json(res, 404, { error: 'Session not found' }); return; }
    await voiceEngine.endSession(params['sessionId']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── REST turn (non-WebSocket clients) ───────────────────────
  //
  // Accepts either:
  //   a) multipart/form-data with 'audio' field (file upload)
  //   b) raw binary body with Content-Type: audio/*
  //   c) JSON body with { text: string } for text-only turns (skips STT)

  router.post('/api/voice/sessions/:sessionId/turn', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const sessionId = params['sessionId']!;
    const session = await voiceEngine.getSession(sessionId, auth.userId);
    if (!session) { json(res, 404, { error: 'Session not found' }); return; }
    if (session.status === 'ended') { json(res, 409, { error: 'Session has ended' }); return; }

    const ct = req.headers['content-type'] ?? '';
    let audio: Buffer = Buffer.alloc(0);
    let mimeType: string | undefined;
    let textOverride: string | undefined;

    if (ct.includes('audio/') || ct.includes('application/octet-stream')) {
      // Raw binary audio body
      audio = await readRawBody(req, VOICE_MAX_AUDIO_BYTES);
      mimeType = ct.split(';')[0]?.trim();
    } else if (ct.includes('multipart/form-data')) {
      // Multipart — parse boundary manually (minimal parser; uses only 'audio' field)
      const raw = await readRawBody(req, VOICE_MAX_AUDIO_BYTES);
      const parsed = parseMultipartAudio(raw, ct);
      if (!parsed) { json(res, 400, { error: 'No audio field found in multipart body' }); return; }
      audio = parsed.data;
      mimeType = parsed.mimeType ?? 'audio/wav';
    } else {
      // JSON body — text-only turn or text override
      const raw = await readBody(req);
      let body: { text?: string; audio?: string; mimeType?: string } = {};
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      if (body.audio) {
        audio = Buffer.from(body.audio, 'base64');
        mimeType = body.mimeType;
      } else if (body.text) {
        textOverride = body.text;
      } else {
        json(res, 400, { error: 'Provide audio (raw body, multipart, or base64 JSON) or text' }); return;
      }
    }

    if (!textOverride && audio.length === 0) {
      json(res, 400, { error: 'Audio body is empty' }); return;
    }
    if (audio.length > VOICE_MAX_AUDIO_BYTES) {
      json(res, 413, { error: `Audio exceeds ${VOICE_MAX_AUDIO_BYTES / 1024 / 1024} MB limit` }); return;
    }

    try {
      const result = await voiceEngine.processTurnRest({ sessionId, userId: auth.userId, audio, mimeType, textOverride });

      // Return JSON with base64 audio + metadata
      json(res, 200, {
        sessionId,
        turnIndex: result.turnIndex,
        transcript: result.transcript,
        responseText: result.responseText,
        responseAudio: result.responseAudio.toString('base64'),
        responseAudioMimeType: result.responseAudioMimeType,
        guardrailDecision: result.guardrailDecision,
        sttMs: result.sttMs,
        llmMs: result.llmMs,
        ttsMs: result.ttsMs,
        costUsd: result.costUsd,
        traceId: result.traceId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('not found') ? 404 : msg.includes('ended') ? 409 : 422;
      json(res, status, { error: msg.slice(0, 300) });
    }
  }, { auth: true, csrf: true });

  // ── Session events (audit log) ──────────────────────────────

  router.get('/api/voice/sessions/:sessionId/events', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const session = await voiceEngine.getSession(params['sessionId']!, auth.userId);
    if (!session) { json(res, 404, { error: 'Session not found' }); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const limit = safePageInt(url.searchParams.get('limit'), 100, 1, 500);
    const events = await (voiceEngine as any).db.listVoiceSessionEvents(params['sessionId']!, auth.userId, limit);
    json(res, 200, { events });
  });
}

// ─── Helpers ──────────────────────────────────────────────────

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { reject(new Error('Audio too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser — extracts the first 'audio' part's binary data. */
function parseMultipartAudio(body: Buffer, contentType: string): { data: Buffer; mimeType?: string } | null {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch?.[1]) return null;
  const boundary = Buffer.from('--' + boundaryMatch[1]);
  const end = Buffer.from('--' + boundaryMatch[1] + '--');

  let pos = 0;
  while (pos < body.length) {
    const bStart = body.indexOf(boundary, pos);
    if (bStart < 0) break;
    const headerStart = bStart + boundary.length + 2; // skip \r\n
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const headerStr = body.subarray(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const bNext = body.indexOf(boundary, dataStart);
    if (bNext < 0) break;
    const dataEnd = bNext - 2; // strip trailing \r\n before next boundary

    if (/name="audio"/i.test(headerStr) || /content-type:\s*audio\//i.test(headerStr)) {
      const mimeMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);
      return {
        data: body.subarray(dataStart, dataEnd),
        mimeType: mimeMatch?.[1]?.trim(),
      };
    }
    pos = bNext;
  }
  return null;
}
