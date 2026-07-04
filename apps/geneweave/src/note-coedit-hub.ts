// SPDX-License-Identifier: MIT
/**
 * geneWeave note co-editing LIVE BROADCAST hub (weaveNotes Phase 2).
 *
 * Runs are co-edited over the run's existing SSE stream; a NOTE has no run, so it
 * needs its own per-note live channel. This is a tiny in-memory pub/sub: each open
 * editor subscribes (an SSE response), the relay broadcasts accepted block-ops and
 * ephemeral presence/awareness updates, and everyone applies them locally so the
 * document and the collaborator cursors stay live.
 *
 * --- For someone new to this ---
 * "SSE" (Server-Sent Events) is a one-way live pipe from server to browser over a
 * normal HTTP request that never closes. When Alice edits, the server pushes her
 * op down everyone else's pipe; their editors apply it instantly. Presence ("Bob
 * is here, cursor at word 12") is broadcast the same way but NEVER stored — it only
 * ever means "right now", so persisting it would be pointless churn.
 *
 * This hub is intentionally process-local. Horizontal scale-out (a Redis fan-out so
 * subscribers on other nodes also receive ops) is a documented follow-up; the op
 * LOG in the database is the durable source of truth, so a peer that misses a live
 * frame always recovers via state-vector diff sync (`/coedit/ops?since=`).
 */
import type { ServerResponse } from 'node:http';
import { formatSseFrame, formatSseComment } from '@weaveintel/core';

interface Sub {
  res: ServerResponse;
  /** Identifies the peer so presence can drop their cursor when they disconnect. */
  peerId: string;
  closed: boolean;
}

export class NoteCoeditHub {
  /** noteId → set of live subscribers. */
  #subs = new Map<string, Set<Sub>>();

  /** How many editors are currently connected to a note (for presence + tests). */
  connectionCount(noteId: string): number {
    return this.#subs.get(noteId)?.size ?? 0;
  }

  /**
   * Attach an SSE subscriber for a note. Writes the SSE preamble, registers the
   * connection, and returns a `detach()` to call when the request closes. Also
   * broadcasts a `presence.join` / `presence.leave` so others see arrivals/departures.
   */
  subscribe(noteId: string, res: ServerResponse, peerId: string): { detach: () => void } {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const sub: Sub = { res, peerId, closed: false };
    const set = this.#subs.get(noteId) ?? new Set<Sub>();
    set.add(sub);
    this.#subs.set(noteId, set);
    // Tell the newcomer who is already here, and tell everyone the newcomer arrived.
    this.#send(sub, 'presence.sync', { peers: [...set].map((s) => s.peerId) });
    this.broadcast(noteId, 'presence.join', { peerId }, sub);

    const detach = (): void => {
      sub.closed = true;
      const s = this.#subs.get(noteId);
      if (s) { s.delete(sub); if (s.size === 0) this.#subs.delete(noteId); }
      this.broadcast(noteId, 'presence.leave', { peerId });
    };
    return { detach };
  }

  /** Broadcast an event to every live subscriber of a note (optionally excluding one). */
  broadcast(noteId: string, event: string, data: unknown, except?: Sub): void {
    const set = this.#subs.get(noteId);
    if (!set || set.size === 0) return;
    for (const sub of [...set]) {
      if (sub === except || sub.closed) continue;
      this.#send(sub, event, data);
      if (sub.closed) set.delete(sub);
    }
    if (set.size === 0) this.#subs.delete(noteId);
  }

  /** Heartbeat to keep proxies from closing idle streams. */
  keepAlive(noteId: string): void {
    const set = this.#subs.get(noteId);
    if (!set) return;
    for (const sub of [...set]) {
      try { sub.res.write(formatSseComment()); } catch { sub.closed = true; set.delete(sub); }
    }
  }

  #send(sub: Sub, event: string, data: unknown): void {
    try {
      sub.res.write(formatSseFrame({ event, data }));
    } catch {
      sub.closed = true; // the next broadcast prunes it
    }
  }
}

/** The process-wide hub instance shared by the notes routes. */
export const noteCoeditHub = new NoteCoeditHub();
