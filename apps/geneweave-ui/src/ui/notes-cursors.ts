// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — LIVE CURSORS + presence rendering (front-end).
 *
 * --- For someone new to this ---
 * When two people open the same note, this draws each other's caret as a little coloured bar
 * with their name — so you can see where your collaborator is typing, in real time. It also
 * shows the AI as a participant ("weaveIntel AI") while it works. None of this is ever saved;
 * it is pure "right now" chatter sent over the note's live pipe (SSE) and rendered on top of the
 * editor.
 *
 * It reuses the server's `@weaveintel/collab` Awareness convention (per-peer last-write-wins by
 * a clock, with a 30s time-to-live so a closed tab's cursor fades). The peer-colour hash here is
 * a deliberate browser-safe MIRROR of `@weaveintel/collab`'s `peerColor` (the package can't be
 * imported into the un-bundled browser client) — same palette, same algorithm, so a person is
 * the same colour on every screen.
 */
import type { NoteCoeditSession, AwarenessLike } from './notes-coedit.js';
import type { EditorInstance } from './notes-editor.js';

// — Mirror of @weaveintel/collab CURSOR_COLORS + peerColor (browser-safe copy) —
const CURSOR_COLORS = ['#D85A30', '#3B6FB0', '#8254C8', '#D98A3D', '#C84A7B', '#2C8C7C', '#B0521F', '#5B6BD6'];
function hashString(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function peerColor(key: string): string { return CURSOR_COLORS[hashString(key) % CURSOR_COLORS.length]!; }

const TTL_MS = 30_000;
const HEARTBEAT_MS = 12_000;
const BROADCAST_THROTTLE_MS = 180;

export interface Participant { peerId: string; name: string; color: string; peerType: string }

export interface LiveCursors {
  /** Feed a peer's awareness entry from the SSE stream (notes-view wires session.onAwareness here). */
  applyAwareness(peerId: string, entry: { clock: number; state: AwarenessLike | null }): void;
  /** Tell the cursors my local caret moved (notes-view wires the editor's onSelectionChange here). */
  onLocalSelectionChange(): void;
  destroy(): void;
}

/**
 * Wire live cursors for an open note. Broadcasts MY caret as I move it, renders everyone else's
 * carets over the editor, and reports the live participant list (for the top-bar avatars).
 */
export function wireLiveCursors(opts: {
  session: NoteCoeditSession;
  editor: EditorInstance;
  container: HTMLElement;
  /** My identity. `clock` is supplied by the caller-stable counter below. */
  me: { name: string; color: string };
  mySiteId: string;
  /** Called whenever the live participant set changes (for top-bar avatars). */
  onParticipants?: (list: Participant[]) => void;
}): LiveCursors {
  const { session, editor, container, me, mySiteId, onParticipants } = opts;
  // Remote peers' awareness (peerId → {state, clock, lastSeen}); LWW by clock, TTL-expired.
  const peers = new Map<string, { state: AwarenessLike; clock: number; lastSeen: number }>();
  let localClock = 0;
  let destroyed = false;

  // The overlay the carets are drawn into (absolutely positioned within the editor mount).
  const overlay = document.createElement('div');
  overlay.className = 'notes-cursors-overlay';
  container.style.position = container.style.position || 'relative';
  container.appendChild(overlay);

  function applyRemote(peerId: string, entry: { clock: number; state: AwarenessLike | null }): void {
    if (peerId === mySiteId) return; // never render my own caret
    if (entry.state === null) { if (peers.delete(peerId)) { render(); reportParticipants(); } return; }
    const existing = peers.get(peerId);
    if (existing && entry.clock <= existing.clock) return; // last-write-wins
    peers.set(peerId, { state: entry.state, clock: entry.clock, lastSeen: Date.now() });
    render();
    reportParticipants();
  }

  function expire(): void {
    const cutoff = Date.now() - TTL_MS;
    let changed = false;
    for (const [peerId, p] of peers) if (p.lastSeen < cutoff) { peers.delete(peerId); changed = true; }
    if (changed) { render(); reportParticipants(); }
  }

  function reportParticipants(): void {
    if (!onParticipants) return;
    const list: Participant[] = [{ peerId: mySiteId, name: me.name, color: me.color, peerType: 'human' }];
    for (const [peerId, p] of peers) list.push({ peerId, name: p.state.name ?? 'Someone', color: p.state.color ?? '#5E6E67', peerType: String(p.state.peerType ?? 'human') });
    onParticipants(list);
  }

  /** Draw a caret + name label for every remote peer that has a cursor. */
  function render(): void {
    if (destroyed) return;
    overlay.innerHTML = '';
    const base = container.getBoundingClientRect();
    for (const [, p] of peers) {
      const head = p.state.cursor?.head;
      if (typeof head !== 'number') continue; // a participant with no caret (e.g. the AI) → avatar only
      const coords = editor.coordsAtPos(Math.min(head, editor.docSize()));
      if (!coords) continue;
      const color = p.state.color ?? '#5E6E67';
      const caret = document.createElement('div');
      caret.className = 'notes-cursor-caret';
      caret.style.left = `${coords.left - base.left}px`;
      caret.style.top = `${coords.top - base.top}px`;
      caret.style.height = `${Math.max(14, coords.bottom - coords.top)}px`;
      caret.style.background = color;
      const label = document.createElement('span');
      label.className = 'notes-cursor-label';
      label.textContent = p.state.name ?? 'Someone';
      label.style.background = color;
      caret.appendChild(label);
      overlay.appendChild(caret);
    }
  }

  // — Broadcast MY caret as it moves (throttled) + a heartbeat so I never time out —
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  function broadcastLocal(status = 'editing'): void {
    if (destroyed) return;
    const sel = editor.getSelection();
    const cursor = sel ? { anchor: sel.anchor, head: sel.head } : null;
    localClock += 1;
    session.broadcastAwareness({ name: me.name, color: me.color, status, peerType: 'human', cursor }, localClock);
  }
  function onLocalMove(): void {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => { throttleTimer = null; broadcastLocal(); }, BROADCAST_THROTTLE_MS);
  }

  const heartbeat = setInterval(() => broadcastLocal('editing'), HEARTBEAT_MS);
  const sweeper = setInterval(expire, 5_000);
  const rerender = setInterval(render, 2_000); // re-anchor carets after layout/scroll shifts
  // Announce myself immediately so others see my caret without waiting for the first move.
  setTimeout(() => broadcastLocal('editing'), 200);

  return {
    applyAwareness: applyRemote,
    onLocalSelectionChange: onLocalMove,
    destroy(): void {
      destroyed = true;
      if (throttleTimer) clearTimeout(throttleTimer);
      clearInterval(heartbeat); clearInterval(sweeper); clearInterval(rerender);
      session.broadcastAwareness(null, ++localClock); // tell the room my cursor is gone
      overlay.remove();
      peers.clear();
    },
  };
}
