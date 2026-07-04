/**
 * history.ts — pure transcript hydration.
 *
 * Maps the server's stored conversation messages (GET
 * `/api/me/conversations/:id/messages`) into the {@link ChatEntry} view models
 * the chat session renders, so re-opening a conversation shows its prior turns
 * instead of an empty window. Framework-agnostic and unit-testable in Node —
 * no React / React Native imports.
 *
 * Each assistant turn is reconstructed as a *terminal* (completed) run view
 * model carrying the stored text. There is no live SSE stream to re-attach for
 * historical turns; only the latest in-flight run (if any) attaches live.
 */

import { emptyRunViewModel, type ConversationMessage, type RunViewModel } from '@weaveintel/api-client';
import type { ChatEntry } from './chat-session.js';

/** A completed run view model that only carries final text (no widgets/tools). */
function completedModel(text: string): RunViewModel {
  return { ...emptyRunViewModel(), status: 'completed', sequence: 0, fullText: text };
}

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Convert stored conversation messages (chronological, oldest-first) into chat
 * entries. Only `user` and `assistant` roles produce visible bubbles; any other
 * role is skipped. Each assistant entry is linked back to the most recent user
 * turn so regenerate/edit affordances have a prompt to replay.
 */
export function messagesToEntries(messages: readonly ConversationMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let lastUser: { id: string; text: string } | null = null;

  for (const m of messages) {
    const createdAt = parseTime(m.createdAt);
    if (m.role === 'user') {
      entries.push({ kind: 'user', id: m.id, text: m.content, createdAt });
      lastUser = { id: m.id, text: m.content };
    } else if (m.role === 'assistant') {
      entries.push({
        kind: 'assistant',
        id: m.id,
        runId: m.id,
        model: completedModel(m.content),
        createdAt,
        promptEntryId: lastUser?.id ?? '',
        promptText: lastUser?.text ?? '',
      });
    }
  }

  return entries;
}
