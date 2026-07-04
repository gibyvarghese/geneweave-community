// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 2 — front-end glue for collaborative note co-editing.
 *
 * --- For someone new to this ---
 * When you open a note, this connects you to the note's live "room" on the server:
 *  - it makes sure the shared (CRDT) copy of the note exists,
 *  - it opens a one-way live pipe (SSE) so you SEE when someone else edits or joins,
 *  - and it routes your saves through the relay as a DIFF, so two people editing the
 *    same note merge instead of overwriting each other.
 *
 * It deliberately stays small and editor-agnostic: it never reaches into Tiptap. On
 * a remote edit it just calls `onRemoteChange()`, and the view decides whether to
 * quietly refresh (you're not typing) or show a "a collaborator edited" nudge.
 */
import { api } from './api.js';

export type CoeditRole = 'owner' | 'collaborator' | 'viewer';

/** One peer's ephemeral awareness (cursor + identity) on the wire. */
export interface AwarenessLike { name?: string; color?: string; status?: string; peerType?: string; cursor?: { anchor?: number; head?: number } | null; [k: string]: unknown }

export interface NoteCoeditSession {
  /** Resolves once the shared doc exists and we know our site id + role + whether live cursors are on. */
  ready: Promise<{ siteId: string; role: CoeditRole; liveCursors: boolean }>;
  /** Save the whole editor document through the relay (diff-on-save; convergent). */
  save(docJson: unknown): Promise<boolean>;
  /** How many editors (including you) are currently in the room. */
  presenceCount(): number;
  /** Broadcast my ephemeral awareness (cursor + identity) to the room (Phase 3). */
  broadcastAwareness(state: AwarenessLike | null, clock: number): void;
  /** Tear down the live connection. */
  close(): void;
}

export interface WireNoteCoeditOpts {
  noteId: string;
  /** Called when a remote op arrives (someone else edited). */
  onRemoteChange: () => void;
  /** Called when the set of live editors changes (presence). */
  onPresence: (count: number) => void;
  /** Phase 3: called when a peer's awareness (cursor/identity) arrives, or they leave (entry.state=null). */
  onAwareness?: (peerId: string, entry: { clock: number; state: AwarenessLike | null }) => void;
}

/** Connect a note to its live co-editing room. Safe to call once per opened note. */
export function wireNoteCoedit(opts: WireNoteCoeditOpts): NoteCoeditSession {
  let role: CoeditRole = 'viewer';
  let siteId = '';
  let liveCursors = false;
  let es: EventSource | null = null;
  let peers = new Set<string>();
  let closed = false;

  const ready = (async (): Promise<{ siteId: string; role: CoeditRole; liveCursors: boolean }> => {
    try {
      const res = await api.post(`/api/me/notes/${opts.noteId}/coedit`, {});
      if (res.ok) {
        const data = (await res.json()) as { siteId?: string; role?: CoeditRole; liveCursors?: boolean };
        siteId = data.siteId ?? '';
        role = data.role ?? 'viewer';
        liveCursors = data.liveCursors !== false;
      }
    } catch { /* fall back to viewer; offline-safe */ }
    if (!closed) connectStream();
    return { siteId, role, liveCursors };
  })();

  function connectStream(): void {
    try {
      es = new EventSource(`/api/me/notes/${opts.noteId}/coedit/events`, { withCredentials: true });
      es.addEventListener('coedit.op', () => { if (!closed) opts.onRemoteChange(); });
      es.addEventListener('coedit.awareness', (e: MessageEvent) => {
        try { const d = JSON.parse(e.data) as { peerId?: string; entry?: { clock: number; state: AwarenessLike | null } }; if (d.peerId && d.entry && !closed) opts.onAwareness?.(d.peerId, d.entry); } catch { /* ignore */ }
      });
      es.addEventListener('presence.sync', (e: MessageEvent) => {
        try { const d = JSON.parse(e.data) as { peers?: string[] }; peers = new Set(d.peers ?? []); opts.onPresence(peers.size); } catch { /* ignore */ }
      });
      es.addEventListener('presence.join', (e: MessageEvent) => {
        try { const d = JSON.parse(e.data) as { peerId?: string }; if (d.peerId) peers.add(d.peerId); opts.onPresence(peers.size); } catch { /* ignore */ }
      });
      es.addEventListener('presence.leave', (e: MessageEvent) => {
        try { const d = JSON.parse(e.data) as { peerId?: string }; if (d.peerId) { peers.delete(d.peerId); opts.onAwareness?.(d.peerId, { clock: Date.now(), state: null }); } opts.onPresence(peers.size); } catch { /* ignore */ }
      });
      es.onerror = () => { /* the durable op log + a reload always recover us */ };
    } catch { /* SSE unsupported — saves still work, just not live */ }
  }

  return {
    ready,
    async save(docJson: unknown): Promise<boolean> {
      try {
        const res = await api.post(`/api/me/notes/${opts.noteId}/coedit/sync`, { doc: docJson });
        return res.ok;
      } catch { return false; }
    },
    presenceCount: () => peers.size,
    broadcastAwareness(state: AwarenessLike | null, clock: number): void {
      if (!siteId) return;
      // Fire-and-forget; presence is best-effort chatter (no await, errors ignored).
      void api.post(`/api/me/notes/${opts.noteId}/coedit/awareness`, { siteId, entry: { clock, state } }).catch(() => {});
    },
    close(): void {
      closed = true;
      if (es) { es.close(); es = null; }
      peers = new Set();
    },
  };
}

/**
 * If the page was opened via a share link (`/?joinNote=<token>`), redeem the token
 * and return the note id to open. Called once at startup. Returns null otherwise.
 */
export async function maybeJoinNoteFromUrl(): Promise<string | null> {
  let token: string | null = null;
  try { token = new URL(window.location.href).searchParams.get('joinNote'); } catch { return null; }
  if (!token) return null;
  try {
    const res = await api.post('/api/me/notes/join', { token });
    if (!res.ok) return null;
    const data = (await res.json()) as { noteId?: string };
    // Clean the token out of the URL so a refresh doesn't re-redeem it.
    try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ }
    return data.noteId ?? null;
  } catch { return null; }
}

/**
 * Mint (and copy) an invite link for a note. Returns the shareable URL the owner can
 * hand to a collaborator (who joins by opening it → POST /api/me/notes/join).
 */
export async function createNoteShareLink(noteId: string, role: 'collaborator' | 'viewer'): Promise<{ token: string; url: string } | null> {
  // Ensure the doc exists so a joiner has something to open, then mint the token.
  await api.post(`/api/me/notes/${noteId}/coedit`, {});
  const res = await api.post(`/api/me/notes/${noteId}/share`, { role });
  if (!res.ok) return null;
  const data = (await res.json()) as { token?: string };
  if (!data.token) return null;
  const url = `${window.location.origin}/?joinNote=${encodeURIComponent(data.token)}`;
  return { token: data.token, url };
}
