// SPDX-License-Identifier: MIT
/**
 * geneWeave note CAPTURE service (weaveNotes Phase 7) — get content INTO notes from a
 * chat RUN, a clipped WEB page, an EMAIL, or a quick JOT, as structured notes.
 *
 * Reuses the pure helpers from `@weaveintel/notes` (parseEmail / buildCaptureNote /
 * dailyNoteTitle), the readable-article extractor from `@weaveintel/tools-browser`
 * (readability / extractContent — pure, regex-based), and the create-a-note path
 * (`agentCreateNote` → markdown → ProseMirror). Every capture lands with a PROVENANCE
 * header and (for runs) a `note_links` row back to the source, so a clip is never
 * anonymous — the "capture then process" workflow.
 *
 * Security: web clips are SSRF-guarded (only public http(s) hosts — no localhost,
 * private ranges, link-local or cloud-metadata) before fetching, on top of the
 * hardened fetch inside `fetchPage`. Run capture goes through `resolveRunAccess`
 * (owner/shared only). Everything is owner-scoped + tenant-isolated.
 */
import { parseEmail, buildCaptureNote, dailyNoteTitle, type EmailFields } from './notes/capture.js';
import { fetchPage, readability, extractContent } from '@weaveintel/tools-browser';
import { newUUIDv7 } from '@weaveintel/core';
import { agentCreateNote } from './note-ai-sql.js';
import { resolveRunAccess } from './shared-session-sql.js';
import type { DatabaseAdapter } from './db-types.js';

type NoteCaptureDb = DatabaseAdapter;

export interface CaptureResult { ok: boolean; error?: string; code?: number; noteId?: string; title?: string; deduped?: boolean }

/** SSRF guard: only public http(s) hosts (no localhost / private / link-local / cloud-metadata). */
export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a >= 224) return false;
  }
  return true;
}

function todayIso(now: () => number): string { return new Date(now()).toISOString().slice(0, 10); }

export function createNoteCaptureService(db: NoteCaptureDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Capture a chat RUN's output as a structured note (owner/shared run only). */
  async function captureRun(input: { runId: string; userId: string; tenantId?: string | null }): Promise<CaptureResult> {
    const access = await resolveRunAccess(db, input.runId, input.userId);
    if (!access) return { ok: false, code: 404, error: 'run not found or not accessible' };
    const events = await db.listUserRunEvents(input.runId);
    let output = '';
    for (const ev of events) {
      if (ev.kind !== 'text.delta') continue;
      try { const p = JSON.parse(ev.payload) as { delta?: unknown }; if (typeof p.delta === 'string') output += p.delta; } catch { /* skip */ }
    }
    // Best-effort prompt from the run metadata (the app may stash a title/prompt there);
    // the run row does NOT persist the chat input, so the title falls back to the output.
    let prompt = '';
    try { const md = JSON.parse(access.run.metadata ?? '{}') as { input?: { text?: unknown }; text?: unknown; title?: unknown }; prompt = String(md.title ?? md.input?.text ?? md.text ?? ''); } catch { /* */ }
    const trimmed = output.trim();
    const firstLine = trimmed.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    const title = (prompt.split('\n')[0] ?? '').slice(0, 80).trim() || firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Chat run capture';
    const body = `${prompt ? `**Asked:** ${prompt}\n\n` : ''}**Answer:**\n\n${trimmed || '(no output)'}`;
    const note = buildCaptureNote({ source: 'run', title, body, sourceLabel: 'Chat run', capturedAt: todayIso(now) });
    const created = await agentCreateNote(db, { userId: input.userId, ...(input.tenantId != null ? { tenantId: input.tenantId } : {}), title: note.title, markdown: note.markdown });
    if (!created.ok) return { ok: false, code: 500, error: created.error };
    // Provenance: link the note back to the run.
    try { await db.createNoteLink({ id: newUUIDv7(), note_id: created.noteId!, target_kind: 'run', target_id: input.runId }); } catch { /* non-fatal */ }
    return { ok: true, noteId: created.noteId!, title: note.title };
  }

  /** Capture a WEB page as a structured note (readable article extraction). SSRF-guarded. */
  async function captureWeb(input: { url: string; userId: string; tenantId?: string | null; html?: string }): Promise<CaptureResult> {
    if (!isSafePublicUrl(input.url)) return { ok: false, code: 400, error: 'unsafe or invalid URL' };
    let html = input.html;
    if (html == null) {
      try { const res = await fetchPage({ url: input.url }); html = res.html ?? ''; }
      catch (e) { return { ok: false, code: 502, error: `could not fetch page: ${e instanceof Error ? e.message : 'error'}` }; }
    }
    if (!html.trim()) return { ok: false, code: 502, error: 'empty page' };
    const read = readability(html);
    const body = (read.textContent && read.textContent.length > 30) ? read.textContent : extractContent(html).text;
    const hostname = (() => { try { return new URL(input.url).hostname; } catch { return input.url; } })();
    const title = read.title?.trim() || hostname;
    const note = buildCaptureNote({ source: 'web', title, body, sourceLabel: hostname, sourceUrl: input.url, capturedAt: todayIso(now) });
    // DEDUP: if this exact URL was already clipped (same title + the URL present in the note body),
    // return that note instead of creating a duplicate on every re-clip.
    try {
      const sameTitle = (await db.listNotes(input.userId, { search: title, limit: 10 })).filter((n) => n.title === note.title);
      for (const cand of sameTitle) {
        const full = await db.getNote(cand.id, input.userId) as { doc_json?: string } | null;
        if (full?.doc_json && full.doc_json.includes(input.url)) return { ok: true, noteId: cand.id, title: note.title, deduped: true };
      }
    } catch { /* dedup is best-effort; fall through to create */ }
    const created = await agentCreateNote(db, { userId: input.userId, ...(input.tenantId != null ? { tenantId: input.tenantId } : {}), title: note.title, markdown: note.markdown });
    return created.ok ? { ok: true, noteId: created.noteId!, title: note.title } : { ok: false, code: 500, error: created.error };
  }

  /** Capture an EMAIL (structured fields or a raw message) as a structured note. */
  async function captureEmail(input: { email: string | EmailFields; userId: string; tenantId?: string | null }): Promise<CaptureResult> {
    const parsed = parseEmail(input.email);
    const note = buildCaptureNote({ source: 'email', title: parsed.subject, body: parsed.bodyText || '(empty email)', ...(parsed.from ? { sourceLabel: parsed.from } : {}), ...(parsed.date ? { capturedAt: parsed.date } : { capturedAt: todayIso(now) }) });
    const created = await agentCreateNote(db, { userId: input.userId, ...(input.tenantId != null ? { tenantId: input.tenantId } : {}), title: note.title, markdown: note.markdown });
    return created.ok ? { ok: true, noteId: created.noteId!, title: note.title } : { ok: false, code: 500, error: created.error };
  }

  /**
   * Quick JOT into today's daily-notes inbox: find-or-create the note titled
   * "Daily Jots — <date>" and append a timestamped bullet. Returns the daily note.
   */
  async function jot(input: { text: string; userId: string; tenantId?: string | null }): Promise<CaptureResult> {
    const text = (input.text ?? '').trim();
    if (!text) return { ok: false, code: 400, error: 'empty jot' };
    const title = dailyNoteTitle(todayIso(now));
    // Find today's daily note (owner-scoped) or create it.
    const existing = (await db.listNotes(input.userId, { search: title, limit: 5 })).find((n) => n.title === title);
    const time = new Date(now()).toISOString().slice(11, 16); // HH:MM
    if (!existing) {
      const md = `# ${title}\n\n- ${time} — ${text}`;
      const created = await agentCreateNote(db, { userId: input.userId, ...(input.tenantId != null ? { tenantId: input.tenantId } : {}), title, markdown: md });
      return created.ok ? { ok: true, noteId: created.noteId!, title } : { ok: false, code: 500, error: created.error };
    }
    // Append a bullet to the existing daily note's ProseMirror doc. The list projection
    // omits doc_json, so fetch the full note to get the current body.
    const full = await db.getNote(existing.id, input.userId);
    let pm: { type: 'doc'; content: unknown[] } = { type: 'doc', content: [] };
    try { pm = JSON.parse(full?.doc_json ?? '') as { type: 'doc'; content: unknown[] }; } catch { /* */ }
    if (!Array.isArray(pm.content)) pm.content = [];
    pm.content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${time} — ${text}` }] }] }] });
    await db.updateNote(existing.id, input.userId, { doc_json: JSON.stringify(pm) });
    return { ok: true, noteId: existing.id, title };
  }

  /** The agent-tool entry point (capture_web_page). */
  async function agentCaptureWeb(args: { userId: string; tenantId?: string | null; url: string }): Promise<{ ok: boolean; error?: string; noteId?: string }> {
    const r = await captureWeb({ url: args.url, userId: args.userId, ...(args.tenantId != null ? { tenantId: args.tenantId } : {}) });
    return r.ok ? { ok: true, noteId: r.noteId! } : { ok: false, ...(r.error ? { error: r.error } : {}) };
  }

  return { captureRun, captureWeb, captureEmail, jot, agentCaptureWeb };
}

export type NoteCaptureService = ReturnType<typeof createNoteCaptureService>;
