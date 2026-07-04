// SPDX-License-Identifier: MIT
/**
 * desktop.ts — the SHARED desktop/quick-capture + offline-session model (weaveNotes Phase 8).
 *
 * Phase 8 wraps the geneWeave web build in a desktop shell (Tauri) with three jobs the web layer
 * actually performs (so they are testable in any browser, not just the native shell):
 *
 *   • **Quick capture** — a global hotkey jots a note from anywhere. {@link parseQuickCapture} turns a
 *     single blob of typed text into a `{ title, body, templateKey? }` the existing create-note path
 *     understands (first line → title, a leading `/template` or `kind:` hint → a system template).
 *   • **Recents / "open to last note"** — {@link pushRecent} / {@link resolveLastNote} maintain a small,
 *     deduped most-recent-first list so the app reopens the note you last had open (the "Done when").
 *   • **Offline cache** — {@link buildNotesSnapshot} / {@link readNotesSnapshot} serialise a compact,
 *     capped, validated snapshot of notes to local storage, so the app launches + renders with no
 *     network and the AI/desktop can still read them.
 *
 * Pure + dependency-light → fully unit-testable in Node; the web UI + the Tauri shell are thin
 * consumers. Quick-capture template hints reuse the Phase-6 {@link templateByKey} registry.
 */
import { templateByKey } from './templates.js';

// ── Quick capture ───────────────────────────────────────────────────────────────

export interface QuickCapture {
  /** A short title (the first non-empty line, trimmed + capped). */
  title: string;
  /** The rest of the text as the note body (may be empty). */
  body: string;
  /** A system template key if the text opened with a hint (e.g. `/meeting` or `todo:`). */
  templateKey?: string;
}

/** Common one-word kind hints → system template keys (Phase 6 templates). */
const KIND_HINTS: Record<string, string> = {
  meeting: 'meeting-minutes', minutes: 'meeting-minutes',
  todo: 'action-board', tasks: 'action-board', todos: 'action-board',
  daily: 'daily-planner', planner: 'daily-planner', plan: 'daily-planner',
  cornell: 'cornell', study: 'study-sheet', revision: 'study-sheet',
  project: 'project-brief', brief: 'project-brief',
  idea: 'zettelkasten', note: 'zettelkasten', zettel: 'zettelkasten',
};

const MAX_TITLE = 120;

/**
 * Parse a quick-capture blob into a note. The first non-empty line is the title; the remainder is the
 * body. A leading `/<word>` or `<word>:` that maps to a known template selects it (and is stripped from
 * the title). Always returns a usable note — an empty blob becomes an Untitled note.
 */
export function parseQuickCapture(text: string): QuickCapture {
  const raw = (text ?? '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  // First non-empty line = title source; everything after it = body.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  let firstLine = (lines[i] ?? '').trim();
  const body = lines.slice(i + 1).join('\n').trim();

  let templateKey: string | undefined;
  // `/meeting …` or `meeting: …` hint at the very start.
  const slash = firstLine.match(/^\/([a-z][a-z0-9-]*)\s*(.*)$/i);
  const colon = firstLine.match(/^([a-z][a-z0-9-]*):\s*(.*)$/i);
  const hit = slash ?? colon;
  if (hit) {
    const key = hit[1]!.toLowerCase();
    const mapped = KIND_HINTS[key];
    // Accept a direct template key too (e.g. `/cornell`).
    const resolved = mapped ?? (templateByKey(key) ? key : undefined);
    if (resolved) { templateKey = resolved; firstLine = (hit[2] ?? '').trim(); }
  }

  const title = (firstLine || 'Untitled').slice(0, MAX_TITLE);
  return { title, body, ...(templateKey ? { templateKey } : {}) };
}

// ── Recents / last note ─────────────────────────────────────────────────────────

export interface RecentNote {
  id: string;
  title: string;
  icon: string | null;
  /** ISO timestamp it was last opened. */
  openedAt: string;
}

export const DEFAULT_RECENTS_LIMIT = 12;

/**
 * Record that a note was opened: move it to the front of the recents list (dedup by id), cap the
 * length. Pure — pass the previous list + the note + a timestamp, get the next list back.
 */
export function pushRecent(recents: RecentNote[], note: { id: string; title: string; icon?: string | null }, openedAt: string, limit = DEFAULT_RECENTS_LIMIT): RecentNote[] {
  if (!note?.id) return recents.slice(0, limit);
  const entry: RecentNote = { id: note.id, title: note.title || 'Untitled', icon: note.icon ?? null, openedAt };
  const rest = recents.filter((r) => r.id !== note.id);
  return [entry, ...rest].slice(0, Math.max(1, limit));
}

/** The most-recently-opened note (what the desktop app reopens on launch), or null. */
export function resolveLastNote(recents: RecentNote[]): RecentNote | null {
  return recents.length > 0 ? recents[0]! : null;
}

// ── Offline snapshot ─────────────────────────────────────────────────────────────

/** One cached note in the offline snapshot (enough to list + open it with no network). */
export interface SnapshotNote {
  id: string;
  title: string;
  icon: string | null;
  favorite: number;
  doc_json: string;
  updated_at: string;
}

export interface NotesSnapshot {
  /** Schema version so a future shape change can invalidate old caches safely. */
  v: 1;
  /** ISO timestamp the snapshot was written. */
  savedAt: string;
  notes: SnapshotNote[];
}

export const SNAPSHOT_VERSION = 1 as const;

/** Build a compact, capped offline snapshot from the user's notes (most-recent first). */
export function buildNotesSnapshot(notes: Array<Partial<SnapshotNote> & { id: string }>, savedAt: string, limit = 500): NotesSnapshot {
  const clean: SnapshotNote[] = [];
  for (const n of notes) {
    if (!n?.id || typeof n.id !== 'string') continue;
    clean.push({
      id: n.id,
      title: typeof n.title === 'string' ? n.title.slice(0, 300) : 'Untitled',
      icon: typeof n.icon === 'string' ? n.icon : null,
      favorite: n.favorite === 1 ? 1 : 0,
      doc_json: typeof n.doc_json === 'string' ? n.doc_json : '{"type":"doc","content":[]}',
      updated_at: typeof n.updated_at === 'string' ? n.updated_at : savedAt,
    });
  }
  clean.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return { v: SNAPSHOT_VERSION, savedAt, notes: clean.slice(0, Math.max(0, limit)) };
}

/** Parse a stored snapshot (string or object). Returns null for missing/old/corrupt data (fail-safe). */
export function readNotesSnapshot(raw: string | NotesSnapshot | null | undefined): NotesSnapshot | null {
  if (!raw) return null;
  let snap: NotesSnapshot;
  try { snap = (typeof raw === 'string' ? JSON.parse(raw) : raw) as NotesSnapshot; } catch { return null; }
  if (!snap || snap.v !== SNAPSHOT_VERSION || !Array.isArray(snap.notes)) return null;
  // Keep only well-formed entries (defensive against a tampered cache).
  snap.notes = snap.notes.filter((n) => n && typeof n.id === 'string' && typeof n.doc_json === 'string');
  return snap;
}

/** Look up one note in a snapshot (used when opening the last note offline). */
export function snapshotNote(snap: NotesSnapshot | null, id: string): SnapshotNote | null {
  return snap?.notes.find((n) => n.id === id) ?? null;
}
