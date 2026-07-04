// Common utility functions for UI
import { state, toYMD } from './state.js';
import { api } from './api.js';
import { noticeDialog } from './dialog.js';

/* Theme Management */
export function normalizeTheme(val: any): 'light' | 'dark' {
  return val === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: 'light' | 'dark') {
  state.theme = theme;
  const html = document.documentElement;
  if (theme === 'dark') {
    html.setAttribute('data-theme', 'dark');
  } else {
    html.removeAttribute('data-theme');
  }
  persistTheme(theme);
}

export function loadStoredTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('geneweave-theme');
  return normalizeTheme(stored);
}

export function persistTheme(theme: 'light' | 'dark') {
  localStorage.setItem('geneweave-theme', theme);
  api.post('/preferences', { theme }).catch(() => {});
}

export function setTheme(theme: 'light' | 'dark') {
  applyTheme(theme);
}

/* Avatar URLs */
export function avatarIndex(name: string): number {
  const AVATAR_COUNT = 26;
  if (!name) return 1;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h) + name.charCodeAt(i);
    h = h & h; // Convert to 32bit integer
  }
  return (Math.abs(h) % AVATAR_COUNT) + 1;
}

export function avatarUrl(index: number): string {
  return `/avatar/avatar-${index}.webp`;
}

export function getUserAvatarUrl(): string {
  const seed = state.user?.id || state.user?.email || 'user';
  return avatarUrl(avatarIndex(seed));
}

export function getAgentAvatarUrl(agentName?: string): string {
  return avatarUrl(avatarIndex(agentName || 'geneweave-agent'));
}

/* Text Processing */
export function normalizeText(txt: string): string {
  return (txt || '').trim().replace(/\s+/g, ' ');
}

export function tokenSet(txt: string): Set<string> {
  return new Set(
    normalizeText(txt)
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0)
  );
}

export function trigramSet(txt: string): Set<string> {
  const text = normalizeText(txt).toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.add(text.substring(i, i + 3));
  }
  return trigrams;
}

export function semanticScore(query: string, text: string): number {
  const qTokens = tokenSet(query);
  const tTokens = tokenSet(text);
  const qTrigrams = trigramSet(query);
  const tTrigrams = trigramSet(text);

  const tokenIntersection = Array.from(qTokens).filter((t) => tTokens.has(t)).length;
  const trigramIntersection = Array.from(qTrigrams).filter((t) => tTrigrams.has(t)).length;

  const tokenScore = qTokens.size > 0 ? tokenIntersection / qTokens.size : 0;
  const trigramScore = qTrigrams.size > 0 ? trigramIntersection / qTrigrams.size : 0;

  return tokenScore * 0.6 + trigramScore * 0.4;
}

/* Chat search */
export function ensureChatSearchIndex(messages: any[]) {
  if (!state._chatSearchIndex) {
    state._chatSearchIndex = {};
    messages.forEach((msg: any, i: number) => {
      state._chatSearchIndex[i] = normalizeText(msg.content || '');
    });
  }
}

export function runSemanticChatSearch(query: string) {
  if (!query.trim()) {
    state.chatSearchResults = [];
    state.chatSearchLoading = false;
    return;
  }

  state.chatSearchLoading = true;
  ensureChatSearchIndex(state.messages);

  const results = state.chats
    .map((c: any) => ({
      id: c.id,
      title: c.title || 'Chat',
      updated_at: c.updated_at || c.created_at,
      score: semanticScore(query, (c.title || '') + ' ' + (c.description || '')),
    }))
    .filter((r: any) => r.score > 0.2)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 5);

  state.chatSearchResults = results;
  state.chatSearchLoading = false;
}

/* Delegated workers */
export function getDelegatedWorkers(messages: any[]): string[] {
  const workers = new Set<string>();
  messages.forEach((m: any) => {
    if (m.steps) {
      m.steps.forEach((s: any) => {
        if (s.type === 'delegation' && (s.worker || s.name)) {
          workers.add(s.worker || s.name);
        }
        if (s.toolCall?.name === 'delegate_to_worker' && s.toolCall?.arguments?.worker) {
          workers.add(s.toolCall.arguments.worker);
        }
      });
    }
  });
  return Array.from(workers);
}

/* Message normalization */
export function normalizeLoadedMessage(msg: any): any {
  if (!msg.processUi && (msg.process || msg.timeline)) {
    msg.processUi = {};
  }
  return msg;
}

/* Data encoding */
export function toBase64(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    return '';
  }
}

/* File handling */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACH_COUNT = 8;

export async function queueFiles(files: File[]) {
  // Collect rejections WITH A REASON so the UI can tell the user why a file didn't attach — never a silent
  // drop (Round 3 / H20). Reasons: too large, too many at once, or unreadable.
  const rejects: Array<{ name: string; reason: string }> = [];
  const room = Math.max(0, MAX_ATTACH_COUNT - (state.pendingAttachments?.length || 0));
  const selected = files.slice(0, room);
  for (const extra of files.slice(room)) rejects.push({ name: extra.name, reason: `only ${MAX_ATTACH_COUNT} files at a time` });

  const encoded = await Promise.all(selected.map((file) => new Promise<any>((resolve) => {
    if (file.size > MAX_ATTACH_BYTES) {
      rejects.push({ name: file.name, reason: 'too large (max 10 MB)' });
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const raw = e.target?.result;
      const base64 = typeof raw === 'string' ? raw.split(',')[1] : null;
      if (!base64) { rejects.push({ name: file.name, reason: 'couldn’t read the file' }); resolve(null); return; }
      resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataBase64: base64 });
    };
    reader.onerror = () => { rejects.push({ name: file.name, reason: 'couldn’t read the file' }); resolve(null); };
    reader.readAsDataURL(file);
  })));

  state.pendingAttachments.push(...encoded.filter(Boolean));
  (state as any).uploadRejections = rejects; // replace — cleared on the next attach/dismiss
  const rerender = (globalThis as any).render;
  if (typeof rerender === 'function') rerender();
}

export function removePendingAttachment(index: number) {
  state.pendingAttachments.splice(index, 1);
}

/* Audio capture → live transcription via the Web Speech API.
 *
 * The mic button no longer attaches an audio file to the message. Instead, it
 * streams the user's speech through `SpeechRecognition` and appends the
 * transcript directly into the chat composer, so the chat receives plain text
 * (consistent with all other input paths). If the browser cannot transcribe,
 * we surface a clear error and never fall back to attaching a raw audio blob.
 */
let speechRecognizer: any = null;

function rerenderUi() {
  const rerender = (globalThis as any).render;
  if (typeof rerender === 'function') rerender();
}

function findComposerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.input-bar textarea');
}

function appendTranscript(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const ta = findComposerTextarea();
  if (!ta) return;
  const sep = ta.value && !/\s$/.test(ta.value) ? ' ' : '';
  ta.value = ta.value + sep + trimmed;
  // Notify the composer's input listener so autosize / state stays in sync.
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

export async function toggleAudioRecording() {
  if (state.audioRecording) {
    stopAudioRecognition();
    return;
  }

  const SpeechRecognitionCtor: any =
    (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    console.error('Speech recognition is not supported in this browser.');
    void noticeDialog({ title: 'Voice input unavailable', message: 'Voice input is not supported in this browser. Try Chrome or Edge.' });
    return;
  }

  try {
    const recognizer = new SpeechRecognitionCtor();
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.lang = (navigator.language || 'en-US');

    recognizer.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          appendTranscript(result[0].transcript);
        }
      }
    };

    recognizer.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error || event);
      state.audioRecording = false;
      speechRecognizer = null;
      rerenderUi();
    };

    recognizer.onend = () => {
      state.audioRecording = false;
      speechRecognizer = null;
      rerenderUi();
    };

    recognizer.start();
    speechRecognizer = recognizer;
    state.audioRecording = true;
    rerenderUi();
  } catch (err) {
    console.error('Failed to start speech recognition:', err);
    state.audioRecording = false;
    speechRecognizer = null;
    rerenderUi();
  }
}

export function stopAudioRecognition() {
  if (speechRecognizer) {
    try {
      speechRecognizer.stop();
    } catch {
      /* no-op — recognizer may already be stopping */
    }
  }
  state.audioRecording = false;
  rerenderUi();
}

/* Clipboard & export */
export async function copyResponse(text: string, btn: HTMLElement) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copyTextWithFeedback(btn);
  } catch (e) {
    console.error('Copy failed:', e);
  }
}

export function copyTextWithFeedback(btn: HTMLElement) {
  const origText = btn.innerText;
  btn.innerText = '✓ Copied!';
  setTimeout(() => {
    btn.innerText = origText;
  }, 2000);
}

export async function emailResponse(text: string, subject: string) {
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  window.location.href = mailto;
}

export async function openInWord(html: string, text: string) {
  try {
    const blob = new Blob([html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'geneweave-response.doc';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Failed to export to Word:', e);
  }
}

/* Numeric utilities */
export function numericValue(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* Text display */
export function shortText(txt: string, maxLen: number = 40): string {
  if (!txt) return '';
  return txt.length > maxLen ? txt.slice(0, maxLen) + '…' : txt;
}

export function detailText(txt: string, maxLen: number = 200): string {
  if (!txt) return '';
  return txt.length > maxLen ? txt.slice(0, maxLen) + '…' : txt;
}

export function summarizeForDisplay(obj: any): string {
  if (typeof obj === 'string') return obj;
  if (!obj) return '';
  if (typeof obj !== 'object') return String(obj);
  try {
    const str = JSON.stringify(obj);
    return str.length > 120 ? str.slice(0, 120) + '…' : str;
  } catch (e) {
    return String(obj);
  }
}

/* Markdown to HTML (basic conversion) */
export function mdToHtml(markdown: string): string {
  if (!markdown) return '';
  let html = markdown
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  if (!html.includes('<p>')) {
    html = '<p>' + html + '</p>';
  }

  return html;
}

/* Scroll helper */
export function scrollMessages(force = false) {
  const container = document.querySelector('.messages') as HTMLElement | null;
  if (!container) return;
  if (force) state.transcriptAtBottom = true;
  // Respect the reader: only auto-scroll when they're already at the bottom (or we're forcing, e.g. on send).
  if (state.transcriptAtBottom === false) return;
  setTimeout(() => {
    state.suppressTranscriptScrollPersist = true;
    container.scrollTop = container.scrollHeight;
    state.transcriptScrollTop = container.scrollTop;
    requestAnimationFrame(() => { state.suppressTranscriptScrollPersist = false; });
  }, 0);
}

/* Render helper (for when render() is called globally) */
export function render() {
  // This will be replaced by the main ui.ts render function
}
