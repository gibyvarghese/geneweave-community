/**
 * Accessible streaming announcements (m140 / H19) — the chat-side glue.
 *
 * Owns ONE visually-hidden `role="status" aria-live="polite"` region and drives it with the pure policy in
 * `@weaveintel/collab` (nextStreamAnnouncement). Instead of the transcript re-announcing the whole
 * conversation every token (the bug), a screen reader hears: "Generating response…", then — depending on the
 * workspace's mode — the finished answer once ('summary'), sentence-complete chunks as they arrive ('live'),
 * or nothing ('off'). Also applies the workspace's reduced-motion default (on top of the OS setting).
 */
import { api } from './api.js';
import { applyForceFocusRing } from './focus.js';
import { setConfirmDestructive } from './dialog.js';
import { setShowSkeletons } from './skeleton.js';

// NOTE: the canonical, unit-tested version of this policy lives in `@weaveintel/collab`
// (stream-announce.ts). The raw-served browser modules can't bare-import a workspace package (only the notes
// editor is bundled), and this decision runs per-token on the client (no server round-trip), so we mirror the
// same pure logic here. Keep the two in sync; the package tests are the spec.
type AnnounceMode = 'summary' | 'live' | 'off';
const GENERATING_MESSAGE = 'Generating response…';
const STOPPED_MESSAGE = 'Response stopped. Partial answer kept.';
const DEFAULT_MIN_INTERVAL_MS = 1200;

function lastSentenceBoundary(s: string): number {
  let idx = -1;
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '.' || c === '!' || c === '?' || c === '\n') idx = i; }
  return idx + 1;
}

function nextStreamAnnouncement(i: { phase: 'start' | 'delta' | 'done' | 'stopped'; fullText: string; lastAnnouncedLen: number; mode: AnnounceMode; nowMs: number; lastAnnounceAtMs: number; minIntervalMs?: number }): { text: string | null; announcedLen: number; announceAtMs: number } {
  const full = typeof i.fullText === 'string' ? i.fullText : '';
  const safeLen = Math.max(0, Math.min(Math.floor(i.lastAnnouncedLen) || 0, full.length));
  const keep = { text: null as string | null, announcedLen: safeLen, announceAtMs: i.lastAnnounceAtMs };
  if (i.mode === 'off') return { ...keep, announcedLen: full.length };
  if (i.phase === 'start') return { text: GENERATING_MESSAGE, announcedLen: 0, announceAtMs: i.nowMs };
  if (i.phase === 'stopped') return { text: STOPPED_MESSAGE, announcedLen: full.length, announceAtMs: i.nowMs };
  if (i.phase === 'done') { const tail = full.slice(safeLen).trim(); return { text: tail || null, announcedLen: full.length, announceAtMs: i.nowMs }; }
  if (i.mode === 'summary') return keep;
  if (i.nowMs - i.lastAnnounceAtMs < (i.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return keep;
  const pending = full.slice(safeLen);
  const boundary = lastSentenceBoundary(pending);
  if (boundary <= 0) return keep;
  const chunk = pending.slice(0, boundary).trim();
  return chunk ? { text: chunk, announcedLen: safeLen + boundary, announceAtMs: i.nowMs } : keep;
}

let _mode: AnnounceMode = 'summary';
let _reducedMotion = false;
// carried between calls for the pure policy
let _announcedLen = 0;
let _announceAt = 0;

export function getAnnounceMode(): AnnounceMode { return _mode; }

/** Load the workspace accessibility defaults + apply reduced-motion. Best-effort. */
export async function loadAccessibilityConfig(): Promise<void> {
  try {
    const res = await api.get('/api/me/accessibility');
    if (res && (res as Response).ok) {
      const d = await (res as Response).json() as { announceMode?: string; reducedMotion?: boolean; alwaysShowFocus?: boolean; confirmDestructive?: boolean; showSkeletons?: boolean };
      if (d.announceMode === 'summary' || d.announceMode === 'live' || d.announceMode === 'off') _mode = d.announceMode;
      _reducedMotion = !!d.reducedMotion;
      applyForceFocusRing(!!d.alwaysShowFocus); // m141 — workspace "always show focus outlines" default
      setConfirmDestructive(d.confirmDestructive !== false); // m142 — default on unless the admin turned it off
      setShowSkeletons(d.showSkeletons !== false); // m144 — default on unless the admin turned it off
    }
  } catch { /* keep defaults */ }
  applyReducedMotion();
  region(); // create the live region up-front so it's always present for assistive tech
}

function applyReducedMotion(): void {
  try {
    const osReduces = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (_reducedMotion || osReduces) document.documentElement.setAttribute('data-reduced-motion', '1');
    else document.documentElement.removeAttribute('data-reduced-motion');
  } catch { /* */ }
}

function region(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('sr-stream-announcer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sr-stream-announcer';
    el.className = 'sr-only';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  return el;
}

/** Now() indirection so tests / SSR don't touch a real clock here (the caller passes real time in practice). */
function now(): number { return typeof performance !== 'undefined' ? performance.now() : 0; }

function emit(phase: 'start' | 'delta' | 'done' | 'stopped', fullText: string): void {
  const r = nextStreamAnnouncement({ phase, fullText, lastAnnouncedLen: _announcedLen, mode: _mode, nowMs: now(), lastAnnounceAtMs: _announceAt });
  _announcedLen = r.announcedLen;
  _announceAt = r.announceAtMs;
  if (r.text == null) return;
  const el = region();
  if (!el) return;
  // Clear first so an identical or repeated string is still re-announced by the AT.
  el.textContent = '';
  // A microtask gap makes the change register as a fresh live-region update.
  setTimeout(() => { el.textContent = r.text!; }, 30);
}

export function announceStreamStart(): void { _announcedLen = 0; _announceAt = 0; emit('start', ''); }
export function announceStreamDelta(fullText: string): void { emit('delta', fullText || ''); }
export function announceStreamDone(fullText: string): void { emit('done', fullText || ''); }
export function announceStreamStopped(fullText: string): void { emit('stopped', fullText || ''); }
