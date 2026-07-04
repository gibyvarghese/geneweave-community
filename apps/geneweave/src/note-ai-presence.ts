// SPDX-License-Identifier: MIT
/**
 * geneWeave — the AI as a LIVE PARTICIPANT in a note (weaveNotes Phase 3).
 *
 * Phase 2 lets two people co-edit a note with live cursors. Phase 3's "Done when" also wants the
 * AI to show up as a THIRD author: while the agent is rewriting or colour-coding a note, everyone
 * with the note open should see a live "weaveIntel AI" participant (mint, woven-mark), then watch
 * its work arrive as a track-changes suggestion. This module is the one place that announces that
 * ephemeral presence over the existing per-note SSE hub.
 *
 * It is gated by the `ai_presence_enabled` weaveNotes setting (Builder-tunable), and it is
 * EPHEMERAL — never stored. The AI's actual edit is still a suggestion the human accepts/rejects;
 * this only adds the "the assistant is working on this right now" live signal.
 */
import { aiPeerId, aiAwarenessState, normalizePresenceStatus } from '@weaveintel/collab';
import { noteCoeditHub } from './note-coedit-hub.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import type { DatabaseAdapter } from './db-types.js';

/**
 * Announce (or clear) the AI participant on a note. `status` of a string (e.g. "composing")
 * joins/updates the AI peer; `null` clears it (the AI left). Best-effort + non-throwing, and a
 * no-op when `ai_presence_enabled` is off. Safe to `void` — presence is never load-bearing.
 */
export async function emitAiPresence(db: Pick<DatabaseAdapter, 'getWeaveNotesSettings'>, noteId: string, status: string | null): Promise<void> {
  try {
    const cfg = await createNoteSettingsService(db as DatabaseAdapter).getConfig();
    if (!cfg.aiPresenceEnabled) return;
    const peerId = aiPeerId(noteId);
    const clock = Date.now();
    if (status === null) {
      noteCoeditHub.broadcast(noteId, 'coedit.awareness', { peerId, entry: { clock, state: null } });
      noteCoeditHub.broadcast(noteId, 'presence.leave', { peerId });
      return;
    }
    noteCoeditHub.broadcast(noteId, 'presence.join', { peerId });
    noteCoeditHub.broadcast(noteId, 'coedit.awareness', { peerId, entry: { clock, state: aiAwarenessState(normalizePresenceStatus(status)) } });
  } catch { /* presence is best-effort */ }
}

/** Run an AI note operation wrapped in "composing" presence, clearing it when done (or on error). */
export async function withAiPresence<T>(db: Pick<DatabaseAdapter, 'getWeaveNotesSettings'>, noteId: string, fn: () => Promise<T>): Promise<T> {
  await emitAiPresence(db, noteId, 'composing');
  try { return await fn(); }
  finally { void emitAiPresence(db, noteId, null); }
}
