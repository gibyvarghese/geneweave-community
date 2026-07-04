/**
 * Answer feedback + AI transparency (m137) — the chat-side UI.
 *
 * Two visible things live here:
 *  1. an "AI-generated" disclosure line under each assistant answer (EU AI Act Article 50), configurable
 *     per workspace by an admin in the Builder → Appearance & AI → AI transparency;
 *  2. a thumbs up / thumbs down control in the response toolbar. A thumbs-down opens a small panel of fixed
 *     reasons (Not accurate / Incomplete / …) + an optional comment, so a down-vote becomes an actionable
 *     signal — the same one the platform already uses to steer model routing.
 *
 * State (which answer you rated, whether the reason panel is open) is kept module-local, keyed by message
 * id, so it survives the transcript's full re-render on every streamed token.
 */
import { h } from './dom.js';
import { api } from './api.js';

interface FeedbackCategory { key: string; label: string; help: string }
interface Transparency {
  showAiLabel: boolean;
  disclosureText: string;
  contentWarnings: boolean;
  feedbackEnabled: boolean;
  categories: FeedbackCategory[];
}

const DEFAULT_TRANSPARENCY: Transparency = {
  showAiLabel: true,
  disclosureText: 'AI-generated — may be inaccurate. Check anything important.',
  contentWarnings: true,
  feedbackEnabled: true,
  categories: [],
};

let _transparency: Transparency = DEFAULT_TRANSPARENCY;
/** messageId → my current feedback (the latest signal + reasons). */
const _myFeedback = new Map<string, { signal: string; categories: string[]; comment: string | null }>();
/** messageId whose reason panel is currently open (only one at a time). */
let _openReasonFor: string | null = null;
/** draft reason selection while the panel is open, keyed by messageId. */
const _draft = new Map<string, { categories: Set<string>; comment: string }>();

export function getTransparency(): Transparency { return _transparency; }

/** Fetch this workspace's transparency config once at startup. Best-effort. */
export async function loadAiTransparency(): Promise<void> {
  try {
    const res = await api.get('/api/me/ai-transparency');
    if (!res || !(res as Response).ok) return;
    const t = await (res as Response).json() as Partial<Transparency>;
    _transparency = { ...DEFAULT_TRANSPARENCY, ...t, categories: Array.isArray(t.categories) ? t.categories : [] };
  } catch { /* keep defaults */ }
}

/** Load my existing feedback for a chat so already-rated answers show their state. Best-effort. */
export async function loadChatFeedback(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    const res = await api.get(`/api/me/chats/${encodeURIComponent(chatId)}/feedback`);
    if (!res || !(res as Response).ok) return;
    const data = await (res as Response).json() as { feedback?: Record<string, { signal: string; categories: string[]; comment: string | null }> };
    for (const [mid, fb] of Object.entries(data.feedback || {})) _myFeedback.set(mid, fb);
  } catch { /* ignore */ }
}

function labelFor(key: string): string {
  return _transparency.categories.find((c) => c.key === key)?.label ?? key;
}

async function submit(message: any, chatId: string, signal: string, rerender: () => void): Promise<void> {
  const messageId = message?.id;
  if (!messageId) return;
  const draft = _draft.get(messageId);
  const categories = signal === 'thumbs_down' && draft ? [...draft.categories] : [];
  const comment = signal === 'thumbs_down' && draft ? draft.comment.trim() : '';
  // Optimistic local state.
  _myFeedback.set(messageId, { signal, categories, comment: comment || null });
  _openReasonFor = null;
  rerender();
  try {
    await api.post(`/api/messages/${encodeURIComponent(messageId)}/feedback`, {
      signal,
      chatId,
      categories,
      comment: comment || null,
      modelId: message?.model ?? undefined,
      provider: message?.provider ?? undefined,
      taskKey: message?.taskKey ?? undefined,
    });
  } catch { /* the optimistic state stands; nothing destructive failed */ }
}

/** The thumbs up/down control (+ reason panel) for one assistant answer. Returns null when disabled. */
export function buildFeedbackControls(message: any, chatId: string, rerender: () => void): HTMLElement | null {
  if (!_transparency.feedbackEnabled) return null;
  const messageId = message?.id;
  if (!messageId) return null; // can only rate a persisted answer
  const mine = _myFeedback.get(messageId);
  const isUp = mine?.signal === 'thumbs_up';
  const isDown = mine?.signal === 'thumbs_down';

  const up = h('button', {
    className: 'tb-btn fb-btn' + (isUp ? ' fb-on' : ''), type: 'button',
    title: 'Good answer', 'aria-label': 'Good answer', 'aria-pressed': String(isUp),
    onClick: () => { void submit(message, chatId, 'thumbs_up', rerender); },
  }, '👍');

  const down = h('button', {
    className: 'tb-btn fb-btn' + (isDown ? ' fb-on' : ''), type: 'button',
    title: 'Needs work', 'aria-label': 'Needs work', 'aria-pressed': String(isDown),
    onClick: () => {
      _openReasonFor = _openReasonFor === messageId ? null : messageId;
      if (_openReasonFor && !_draft.has(messageId)) _draft.set(messageId, { categories: new Set(mine?.categories ?? []), comment: mine?.comment ?? '' });
      rerender();
    },
  }, '👎');

  const wrap = h('div', { className: 'fb-wrap' }, up, down);

  // Confirmation chip once a down-vote reason is recorded.
  if (isDown && (mine?.categories?.length || mine?.comment)) {
    wrap.appendChild(h('span', { className: 'fb-thanks', role: 'status' },
      'Thanks — noted' + (mine!.categories.length ? `: ${mine!.categories.map(labelFor).join(', ')}` : '')));
  }

  if (_openReasonFor === messageId) wrap.appendChild(buildReasonPanel(message, chatId, rerender));
  return wrap;
}

function buildReasonPanel(message: any, chatId: string, rerender: () => void): HTMLElement {
  const messageId = message.id;
  const draft = _draft.get(messageId) ?? { categories: new Set<string>(), comment: '' };
  _draft.set(messageId, draft);

  const chips = _transparency.categories.map((c) => h('button', {
    className: 'fb-chip' + (draft.categories.has(c.key) ? ' on' : ''), type: 'button',
    title: c.help || c.label, 'aria-pressed': String(draft.categories.has(c.key)),
    onClick: () => { draft.categories.has(c.key) ? draft.categories.delete(c.key) : draft.categories.add(c.key); rerender(); },
  }, c.label));

  const comment = h('textarea', {
    className: 'fb-comment', rows: '2', maxLength: '1000',
    placeholder: 'Anything else? (optional)', 'aria-label': 'Optional feedback comment',
    oninput: (e: Event) => { draft.comment = (e.target as HTMLTextAreaElement).value; },
  }) as HTMLTextAreaElement;
  comment.value = draft.comment;

  return h('div', { className: 'fb-panel', role: 'group', 'aria-label': 'Why wasn’t this answer good?' },
    h('div', { className: 'fb-panel-title' }, 'What went wrong?'),
    h('div', { className: 'fb-chips' }, ...chips),
    comment,
    h('div', { className: 'fb-panel-actions' },
      h('button', { className: 'fb-cancel', type: 'button', onClick: () => { _openReasonFor = null; rerender(); } }, 'Cancel'),
      h('button', { className: 'fb-send', type: 'button', onClick: () => { void submit(message, chatId, 'thumbs_down', rerender); } }, 'Send feedback'),
    ),
  );
}

/** The "AI-generated" disclosure line shown under an assistant answer, if the workspace enables it. */
export function buildAiDisclosure(): HTMLElement | null {
  if (!_transparency.showAiLabel) return null;
  return h('div', { className: 'ai-disclosure', role: 'note' },
    h('span', { className: 'ai-disclosure-dot', 'aria-hidden': 'true' }, '✦'),
    h('span', null, _transparency.disclosureText));
}
