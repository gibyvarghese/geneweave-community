// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 4 — voice / meeting capture UI.
 *
 * --- For someone new to this ---
 * Two things live here:
 *   1. A RECORDER panel (Insert → 🎙 Record meeting). Press record, talk (or hold a meeting), press
 *      stop. Your browser captures the audio, sends it to be transcribed, and the app writes you a
 *      tidy note — a summary, the decisions, and action items as to-do checkboxes — where every point
 *      links back to the exact moment it was said. You can also drop in an audio FILE, or PASTE a
 *      transcript you already have. Your audio isn't kept — only the transcript.
 *   2. A small enhancer that makes those timestamp links CLICKABLE: in a meeting note, clicking a
 *      point (which shows a ⟦m:ss⟧ marker) scrolls the transcript to that moment and flashes it.
 */
import { h } from './dom.js';
import { api } from './api.js';

/** Read a Blob as base64 (chunked, so large recordings don't blow the call stack). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

interface TranscribeResult { ok: boolean; error?: string; text?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> }
interface MeetingCreated { ok: boolean; error?: string; noteId?: string; title?: string; summary?: string; actionItems?: Array<{ text: string }>; coverage?: { cited: number; total: number } }

/**
 * The recorder panel body. `onCreated(noteId)` fires once a meeting note is created (the caller opens
 * it). Provides three on-ramps: live recording (mic), audio-file upload, and paste-a-transcript.
 */
export function renderMeetingRecorder(onCreated: (noteId: string) => void): HTMLElement {
  const status = h('div', { className: 'notes-meeting-status' }) as HTMLElement;
  const timer = h('span', { className: 'notes-meeting-timer' }, '0:00') as HTMLElement;
  const recordBtn = h('button', { className: 'notes-meeting-record' }, '● Record') as HTMLButtonElement;
  const setStatus = (msg: string, kind = ''): void => { status.textContent = msg; status.className = `notes-meeting-status ${kind}`; };

  let media: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let tick: ReturnType<typeof setInterval> | null = null;

  const stopTracks = (): void => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  const resetTimer = (): void => { if (tick) { clearInterval(tick); tick = null; } };

  /** Send the recorded/uploaded audio to be transcribed, then structured into a note. */
  async function processAudio(blob: Blob, title: string): Promise<void> {
    if (blob.size < 200) { setStatus('That recording was empty — try again.', 'err'); recordBtn.disabled = false; return; }
    setStatus('Transcribing your audio…', 'busy');
    let tr: TranscribeResult;
    try {
      const b64 = await blobToBase64(blob);
      const res = await api.post('/api/me/notes/meeting/transcribe', { audio: b64, mimeType: blob.type || 'audio/webm' });
      tr = await res.json().catch(() => ({ ok: false })) as TranscribeResult;
      if (!res.ok || !tr.ok) { setStatus(tr.error || 'Could not transcribe that audio.', 'err'); recordBtn.disabled = false; return; }
    } catch { setStatus('Could not reach the server to transcribe.', 'err'); recordBtn.disabled = false; return; }
    if (!tr.segments || !tr.segments.length) { setStatus('No speech was detected in that audio.', 'err'); recordBtn.disabled = false; return; }

    setStatus('Writing your meeting note…', 'busy');
    try {
      const res = await api.post('/api/me/notes/meeting', { segments: tr.segments, title, source: 'recording', ...(tr.duration ? { durationSec: tr.duration } : {}) });
      const created = await res.json().catch(() => ({ ok: false })) as MeetingCreated;
      if (!res.ok || !created.ok || !created.noteId) { setStatus(created.error || 'Could not create the note.', 'err'); recordBtn.disabled = false; return; }
      const cov = created.coverage ? ` · ${created.coverage.cited}/${created.coverage.total} points cited` : '';
      setStatus(`Done — “${created.title}”${cov}`, 'ok');
      document.querySelector('.gw-modal-overlay')?.remove();
      onCreated(created.noteId);
    } catch { setStatus('Could not create the note.', 'err'); recordBtn.disabled = false; }
  }

  recordBtn.addEventListener('click', async () => {
    if (media && media.state === 'recording') { media.stop(); return; }
    // Start recording.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { setStatus('Microphone permission was denied.', 'err'); return; }
    chunks = [];
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) || '';
    try { media = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch { media = new MediaRecorder(stream); }
    media.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    media.onstop = () => {
      resetTimer(); stopTracks();
      recordBtn.textContent = '● Record'; recordBtn.classList.remove('recording'); recordBtn.disabled = true;
      const blob = new Blob(chunks, { type: media?.mimeType || 'audio/webm' });
      const title = `Recording — ${new Date().toLocaleString()}`;
      void processAudio(blob, title);
    };
    media.start();
    startedAt = Date.now();
    recordBtn.textContent = '■ Stop'; recordBtn.classList.add('recording');
    setStatus('Recording… speak now. Your audio is not stored — only the transcript.', 'busy');
    resetTimer();
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  });

  // Audio-file upload on-ramp.
  const fileInput = h('input', { type: 'file', accept: 'audio/*,video/webm', style: 'display:none' }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0]; if (!f) return;
    recordBtn.disabled = true;
    void processAudio(f, f.name.replace(/\.[^.]+$/, '') || 'Recording');
  });
  const uploadBtn = h('button', { className: 'notes-meeting-secondary', onClick: () => fileInput.click() }, '⬆ Upload audio') as HTMLElement;

  // Paste-a-transcript on-ramp (no audio needed).
  const pasteArea = h('textarea', { className: 'notes-meeting-paste', placeholder: 'Or paste a transcript you already have…', rows: 4 }) as HTMLTextAreaElement;
  const pasteBtn = h('button', { className: 'notes-meeting-secondary', onClick: async () => {
    const text = pasteArea.value.trim(); if (!text) { setStatus('Paste a transcript first.', 'err'); return; }
    setStatus('Writing your meeting note…', 'busy'); pasteBtn.setAttribute('disabled', 'true');
    try {
      const res = await api.post('/api/me/notes/meeting/summarize', { transcript: text });
      const created = await res.json().catch(() => ({ ok: false })) as MeetingCreated;
      if (!res.ok || !created.ok || !created.noteId) { setStatus(created.error || 'Could not summarise that.', 'err'); pasteBtn.removeAttribute('disabled'); return; }
      document.querySelector('.gw-modal-overlay')?.remove();
      onCreated(created.noteId);
    } catch { setStatus('Could not summarise that.', 'err'); pasteBtn.removeAttribute('disabled'); }
  } }, '✎ Summarise transcript') as HTMLElement;

  return h('div', { className: 'notes-meeting-panel' },
    h('p', { className: 'notes-meeting-intro' }, 'Record a meeting or voice memo. When you stop, it’s transcribed and turned into a note — a summary, decisions, and action items — where every point links back to the moment it was said. Your audio isn’t kept; only the transcript.'),
    h('div', { className: 'notes-meeting-controls' }, recordBtn, timer, uploadBtn, fileInput),
    status,
    h('div', { className: 'notes-meeting-paste-wrap' }, pasteArea, pasteBtn),
  ) as HTMLElement;
}

/**
 * Make a meeting note's transcript citations clickable. For a note that has a meeting, clicking any
 * point that carries a ⟦m:ss⟧ marker scrolls the transcript to that moment and flashes it. No-op for
 * ordinary notes. Returns a teardown.
 */
export function wireMeetingTranscript(opts: { noteId: string; editorContainer: HTMLElement }): { destroy: () => void } {
  const { noteId, editorContainer } = opts;
  let onClick: ((e: Event) => void) | null = null;
  let flashEl: HTMLElement | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  void (async () => {
    let isMeeting = false;
    try { const res = await api.get(`/api/me/notes/${noteId}/meeting`); isMeeting = res.ok; } catch { isMeeting = false; }
    if (!isMeeting) return;
    editorContainer.classList.add('notes-has-meeting');

    // Build a map: "m:ss" → the transcript line element (a paragraph that starts with [m:ss]).
    const tsToLine = (): Map<string, HTMLElement> => {
      const map = new Map<string, HTMLElement>();
      editorContainer.querySelectorAll<HTMLElement>('p, li').forEach((el) => {
        const m = (el.textContent || '').match(/^\s*\[(\d+:\d{2}(?::\d{2})?)\]/);
        if (m && !map.has(m[1]!)) map.set(m[1]!, el);
      });
      return map;
    };

    onClick = (e: Event): void => {
      const target = (e.target as HTMLElement)?.closest?.('p, li, strong, span') as HTMLElement | null;
      if (!target) return;
      const text = target.textContent || '';
      // Only citation markers (⟦m:ss⟧) trigger navigation — not the transcript's own [m:ss] labels.
      const m = text.match(/⟦(\d+:\d{2}(?::\d{2})?)⟧/);
      if (!m) return;
      const line = tsToLine().get(m[1]!);
      if (!line) return;
      line.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (flashEl) flashEl.classList.remove('notes-meeting-flash');
      if (flashTimer) clearTimeout(flashTimer);
      line.classList.add('notes-meeting-flash');
      flashEl = line;
      flashTimer = setTimeout(() => { line.classList.remove('notes-meeting-flash'); }, 1800);
    };
    // Capture phase so the handler runs even if the editor stops the click from bubbling.
    editorContainer.addEventListener('click', onClick, true);
  })();

  return { destroy() { if (onClick) editorContainer.removeEventListener('click', onClick, true); if (flashTimer) clearTimeout(flashTimer); } };
}
