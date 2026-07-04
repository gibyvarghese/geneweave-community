// SPDX-License-Identifier: MIT
/**
 * notes-offline.ts — the desktop/web offline cache for notes (weaveNotes Phase 8, desktop G8).
 *
 * So the (desktop) app can LAUNCH OFFLINE and reopen your last note, the notes list + each opened
 * note's content are mirrored into a compact local snapshot in `localStorage` (which works in a browser
 * AND the Tauri webview). On a normal launch the server is the source of truth; when it is unreachable,
 * the UI hydrates from this snapshot instead of erroring.
 *
 * This is a deliberately thin, browser-only store (a UI concern). The canonical, richer + unit-tested
 * snapshot/recents model lives in `@weaveintel/notes` (`desktop.ts`) for the native shells; it is not
 * imported here because the geneWeave web modules are served raw (no bundler / bare-import resolution).
 */

interface CachedNote { id: string; title: string; icon: string | null; favorite: number; doc_json: string; updated_at: string }
interface Snapshot { v: 1; savedAt: string; notes: CachedNote[] }

const SNAPSHOT_KEY = 'geneweave.notes.snapshot.v1';
const LAST_NOTE_KEY = 'geneweave.notes.lastNoteId.v1';
const DEFAULT_LIMIT = 500;

function coerce(n: Record<string, unknown>): CachedNote | null {
  if (!n || typeof n['id'] !== 'string') return null;
  return {
    id: n['id'] as string,
    title: typeof n['title'] === 'string' ? (n['title'] as string).slice(0, 300) : 'Untitled',
    icon: typeof n['icon'] === 'string' ? (n['icon'] as string) : null,
    favorite: n['favorite'] === 1 ? 1 : 0,
    doc_json: typeof n['doc_json'] === 'string' ? (n['doc_json'] as string) : '{"type":"doc","content":[]}',
    updated_at: typeof n['updated_at'] === 'string' ? (n['updated_at'] as string) : new Date().toISOString(),
  };
}

/** Mirror the current note list into the offline snapshot (called after a successful list/load). */
export function saveNotesSnapshot(notes: Array<Record<string, unknown>>, limit = DEFAULT_LIMIT): void {
  try {
    const clean = notes.map(coerce).filter((n): n is CachedNote => n !== null)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, limit);
    const snap: Snapshot = { v: 1, savedAt: new Date().toISOString(), notes: clean };
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* storage full / unavailable — offline cache is best-effort */ }
}

/** Merge ONE note's full content into the snapshot (called when a note is opened or saved). */
export function cacheNote(note: Record<string, unknown>): void {
  const entry = coerce(note);
  if (!entry) return;
  const others = offlineNotes().filter((n) => n.id !== entry.id);
  saveNotesSnapshot([entry, ...others] as unknown as Array<Record<string, unknown>>);
}

function readSnapshot(): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    if (!snap || snap.v !== 1 || !Array.isArray(snap.notes)) return null;
    snap.notes = snap.notes.filter((n) => n && typeof n.id === 'string' && typeof n.doc_json === 'string');
    return snap;
  } catch { return null; }
}

/** The cached notes as a list (for rendering the list offline), newest first. */
export function offlineNotes(): CachedNote[] {
  return readSnapshot()?.notes ?? [];
}

/** Look up one cached note (for opening it offline). */
export function offlineNote(id: string): CachedNote | null {
  return offlineNotes().find((n) => n.id === id) ?? null;
}

/** Remember / read the last-opened note (drives "open to last note" on launch). */
export function setLastNoteId(id: string): void {
  try { window.localStorage.setItem(LAST_NOTE_KEY, id); } catch { /* */ }
}
export function getLastNoteId(): string | null {
  try { return window.localStorage.getItem(LAST_NOTE_KEY); } catch { return null; }
}
