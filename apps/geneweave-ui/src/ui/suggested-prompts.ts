/**
 * Suggested / starter prompts — the client side (m146).
 *
 * The empty chat shows a few CLICKABLE conversation starters instead of a blank screen. The server does all
 * the thinking (curated defaults + personalised-from-your-own-notes/chats, deduped + ranked via the pure
 * @weaveintel/collab core) and hands the UI the final list; this module just fetches it, renders the
 * cards, and logs which one was picked. Personalised cards get a subtle "for you" (mint) treatment so it's
 * clear they were tailored — never sent to another user (owner-scoped on the server).
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface StarterPrompt {
  id: string;
  title: string;
  prompt: string;
  category: string;
  source: 'curated' | 'note' | 'chat' | 'ai';
  icon?: string;
  noteId?: string;
}

let _prompts: StarterPrompt[] = [];
let _enabled = true;

/** Fetch the effective starter list for the signed-in reader. Safe to call repeatedly. */
export async function loadSuggestedPrompts(): Promise<void> {
  try {
    const res = await api.get('/api/me/suggested-prompts');
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as { enabled?: boolean; prompts?: StarterPrompt[] };
    _enabled = d.enabled !== false;
    _prompts = Array.isArray(d.prompts) ? d.prompts : [];
  } catch { /* keep the last-known list (empty on first load) */ }
}

export function starterPromptsEnabled(): boolean { return _enabled; }
export function getStarterPrompts(): StarterPrompt[] { return _prompts; }

/** Log a click (best-effort; the assistant still runs regardless). */
export function logPromptClick(p: StarterPrompt): void {
  try {
    void api.post('/api/me/suggested-prompts/click', { promptId: p.id, title: p.title, source: p.source });
  } catch { /* ignore */ }
}

/**
 * Build the starter-cards grid. `onPick(p)` is called when a card is activated (click / Enter / Space).
 * Returns null when there's nothing to show, so the caller can fall back to the plain empty state.
 */
export function buildStarterCards(onPick: (p: StarterPrompt) => void): HTMLElement | null {
  if (!_enabled || !_prompts.length) return null;
  const grid = h('div', { className: 'suggested-prompts', role: 'list', 'aria-label': 'Suggested prompts' });
  for (const p of _prompts) {
    const personalized = p.source !== 'curated';
    const card = h('button', {
      type: 'button',
      className: `prompt-card${personalized ? ' personalized' : ''}`,
      role: 'listitem',
      title: p.prompt,
      onClick: () => { logPromptClick(p); onPick(p); },
    },
      h('span', { className: 'prompt-card-icon', 'aria-hidden': 'true' }, p.icon || '💬'),
      h('span', { className: 'prompt-card-body' },
        h('span', { className: 'prompt-card-title' }, p.title),
        personalized ? h('span', { className: 'prompt-card-tag' }, 'For you') : null,
      ),
    );
    grid.appendChild(card);
  }
  return grid;
}
