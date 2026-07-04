// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 4 — voice / meeting capture service.
 *
 * Turns a recording into a structured note: (1) TRANSCRIBE the audio to timestamped segments (using
 * the app's speech-to-text model — the same Whisper the voice agent uses, extended to return segment
 * timestamps), (2) STRUCTURE it with the LLM into a summary + decisions + action items where every
 * point cites a real transcript quote, (3) VERIFY each citation against the transcript (dropping any
 * the model made up) and anchor it to the moment it was said, (4) CREATE a provenance-stamped note and
 * persist the transcript so the UI can render clickable "jump to that moment" citations.
 *
 * Privacy (the Granola / bot-less posture): we store the TRANSCRIPT, not the audio. Raw audio is only
 * retained when the workspace explicitly opts in (`storeAudio`). Every capture is owner-scoped and
 * tenant-isolated. The transcript is treated as untrusted DATA (prompt-injection defended).
 *
 * Reuses `@weaveintel/notes` pure helpers (buildMeetingPrompt / parseMeetingReply /
 * verifyMeetingCitations / buildMeetingNoteMarkdown) + `agentCreateNote` (markdown → note).
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  buildMeetingPrompt, parseMeetingReply, verifyMeetingCitations, citationCoverage, buildMeetingNoteMarkdown,
  transcriptDuration, type TranscriptSegment, type MeetingStructured,
} from './notes/meeting.js';
import type { DatabaseAdapter } from './db-types/adapter.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import { agentCreateNote } from './note-ai-sql.js';

/** Detailed transcription callback the host wires from the audio model (verbose/segmented Whisper). */
export type MeetingTranscribe = (input: {
  audio: Buffer;
  mimeType?: string;
  language?: string;
  model?: string;
  userId: string;
  tenantId?: string | null;
}) => Promise<{ text: string; language?: string; duration?: number; segments: TranscriptSegment[] }>;

export interface MeetingResult {
  ok: boolean;
  error?: string;
  code?: number;
  noteId?: string;
  meetingId?: string;
  title?: string;
  summary?: string;
  actionItems?: Array<{ text: string; owner?: string; at?: number }>;
  coverage?: { cited: number; total: number };
}

/** Split a pasted/plain transcript into pseudo-segments (one per line/sentence) so citations still anchor. */
export function textToSegments(text: string): TranscriptSegment[] {
  const parts = (text ?? '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.map((t, i) => ({ start: i, end: i + 1, text: t }));
}

export function createNoteMeetingService(
  db: DatabaseAdapter,
  opts: { transcribe?: MeetingTranscribe; generate?: NoteAiGenerate; now?: () => number } = {},
) {
  const now = opts.now ?? (() => Date.now());

  /** Structure verified segments into a note + persist the meeting. Shared by upload + agent paths. */
  async function structureAndSave(input: {
    userId: string; tenantId?: string | null; segments: TranscriptSegment[];
    title?: string; sourceLabel?: string; source?: string; language?: string; durationSec?: number;
    audioRetained?: boolean;
  }): Promise<MeetingResult> {
    if (!opts.generate) return { ok: false, code: 501, error: 'AI is not configured on this server' };
    const segments = (input.segments ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
    if (!segments.length) return { ok: false, code: 400, error: 'empty transcript' };

    const prompt = buildMeetingPrompt(segments, { ...(input.title ? { title: input.title } : {}), maxChars: 24000 });
    let reply = '';
    try {
      reply = await opts.generate({ system: prompt.system, user: prompt.user, userId: input.userId, tenantId: input.tenantId ?? null, temperature: 0, maxTokens: 1500 });
    } catch (e) {
      return { ok: false, code: 502, error: `summarisation failed: ${(e as Error).message}` };
    }
    const parsed = parseMeetingReply(reply);
    const structured: MeetingStructured = verifyMeetingCitations(parsed, segments, input.title ? { title: input.title } : {});
    const durationSec = input.durationSec ?? transcriptDuration(segments);
    const capturedAt = new Date(now()).toISOString().slice(0, 10);
    const markdown = buildMeetingNoteMarkdown(structured, segments, {
      capturedAt,
      sourceLabel: input.sourceLabel ?? 'Meeting notes',
      durationSec,
    });
    const title = structured.title || input.title || 'Meeting notes';

    const created = await agentCreateNote(db, { userId: input.userId, ...(input.tenantId != null ? { tenantId: input.tenantId } : {}), title, markdown });
    if (!created.ok || !created.noteId) return { ok: false, code: 500, error: created.error ?? 'could not create note' };

    const coverage = citationCoverage(structured);
    const meetingId = newUUIDv7();
    try {
      await db.createNoteMeeting?.({
        id: meetingId,
        note_id: created.noteId,
        user_id: input.userId,
        tenant_id: input.tenantId ?? null,
        title,
        source: input.source ?? 'recording',
        language: input.language ?? null,
        duration_sec: Math.round(durationSec),
        segments_json: JSON.stringify(segments),
        summary: structured.summary,
        action_items_json: JSON.stringify(structured.actionItems),
        decisions_json: JSON.stringify(structured.decisions),
        cited: coverage.cited,
        cite_total: coverage.total,
        audio_retained: input.audioRetained ? 1 : 0,
        created_at: new Date(now()).toISOString(),
      });
    } catch { /* the note still exists even if the meeting record fails */ }

    // Provenance: the AI actor authored a meeting note from a recording (so later tools understand it).
    try {
      await db.recordNoteActivity?.({
        id: newUUIDv7(), note_id: created.noteId, user_id: input.userId, tenant_id: input.tenantId ?? null,
        action: 'created', actor: 'ai', summary: `Captured “${title}” from ${input.sourceLabel ?? 'a recording'}`,
        detail_json: JSON.stringify({ via: 'meeting_capture', durationSec: Math.round(durationSec), cited: coverage.cited, total: coverage.total }),
        created_at: new Date(now()).toISOString(),
      });
    } catch { /* non-fatal */ }

    return {
      ok: true, noteId: created.noteId, meetingId, title,
      summary: structured.summary,
      actionItems: structured.actionItems.map((a) => ({ text: a.text, ...(a.owner ? { owner: a.owner } : {}), ...(a.cite ? { at: a.cite.start } : {}) })),
      coverage,
    };
  }

  return {
    /** Transcribe uploaded audio → timestamped segments (no note yet). Audio is NOT persisted. */
    async transcribe(input: { userId: string; tenantId?: string | null; audio: Buffer; mimeType?: string; language?: string; model?: string }): Promise<{ ok: boolean; code?: number; error?: string; text?: string; language?: string; duration?: number; segments?: TranscriptSegment[] }> {
      if (!opts.transcribe) return { ok: false, code: 501, error: 'Speech-to-text is not configured on this server' };
      if (!input.audio || input.audio.byteLength < 128) return { ok: false, code: 400, error: 'audio is empty or too short' };
      try {
        const r = await opts.transcribe({ audio: input.audio, ...(input.mimeType ? { mimeType: input.mimeType } : {}), ...(input.language ? { language: input.language } : {}), ...(input.model ? { model: input.model } : {}), userId: input.userId, tenantId: input.tenantId ?? null });
        return { ok: true, text: r.text, ...(r.language ? { language: r.language } : {}), ...(r.duration !== undefined ? { duration: r.duration } : {}), segments: r.segments };
      } catch (e) {
        return { ok: false, code: 502, error: `transcription failed: ${(e as Error).message}` };
      }
    },

    /** Full path: transcript segments → structured, cited note. */
    createMeetingNote: structureAndSave,

    /** Agent-tool entry: a plain transcript (text) → structured, cited note. */
    async agentSummarizeMeeting(args: { userId: string; tenantId?: string | null; transcript: string; title?: string }): Promise<{ ok: boolean; error?: string; noteId?: string; title?: string; summary?: string; actionItems?: number }> {
      const segments = textToSegments(args.transcript ?? '');
      if (!segments.length) return { ok: false, error: 'empty transcript' };
      const r = await structureAndSave({ userId: args.userId, tenantId: args.tenantId ?? null, segments, ...(args.title ? { title: args.title } : {}), sourceLabel: 'Pasted transcript', source: 'import' });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, noteId: r.noteId!, title: r.title!, summary: r.summary!, actionItems: r.actionItems?.length ?? 0 };
    },

    /** The stored meeting for a note (transcript segments + structured points), for the UI. Owner-scoped. */
    async getMeeting(noteId: string, userId: string): Promise<{ ok: boolean; meeting?: unknown }> {
      const row = await db.getNoteMeetingByNote?.(noteId, userId);
      if (!row) return { ok: false };
      const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
      return {
        ok: true,
        meeting: {
          noteId, title: row.title, source: row.source, language: row.language, durationSec: row.duration_sec,
          summary: row.summary, cited: row.cited, citeTotal: row.cite_total,
          segments: parse<TranscriptSegment[]>(row.segments_json, []),
          actionItems: parse<unknown[]>(row.action_items_json, []),
          decisions: parse<unknown[]>(row.decisions_json, []),
        },
      };
    },
  };
}

export type NoteMeetingService = ReturnType<typeof createNoteMeetingService>;
