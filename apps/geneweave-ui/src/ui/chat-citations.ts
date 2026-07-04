/**
 * Answer citations in chat (m138) — the chat-side UI.
 *
 * A "Cite sources" toggle sits by the composer (shown only when an admin has enabled it for the workspace).
 * With it on, a message is answered by the grounded engine — POST /api/me/chats/:id/cite — which returns the
 * answer with inline [n] markers plus VERIFIED citations (each quote proven to exist in a note or past chat).
 * The answer renders with each [n] as a clickable chip and a list of source cards below; clicking a note
 * source opens that note and highlights the exact line. Reuses the same citation look as "Ask your workspace".
 *
 * State (config + whether the toggle is on) is module-local; per-message citations live on the message's
 * metadata (persisted server-side), so they survive a reload with no extra fetch.
 */
import { h } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';

interface CiteConfig { enabled: boolean; minCitations: number; scope: string; maxSources: number }
interface Cite { n: number; sourceId: string; sourceKind: string; sourceTitle: string; quote: string }

let _config: CiteConfig = { enabled: false, minCitations: 1, scope: 'all', maxSources: 6 };
let _citeMode = false;
let _citing = false;

export function isCitationsEnabled(): boolean { return _config.enabled; }
export function isCiteMode(): boolean { return _citeMode && _config.enabled; }
export function isCiting(): boolean { return _citing; }

/** Load this workspace's citation config once at startup. Best-effort. */
export async function loadChatCitationsConfig(): Promise<void> {
  try {
    const res = await api.get('/api/me/chat-citations');
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as Partial<CiteConfig>;
    _config = { enabled: !!d.enabled, minCitations: Number(d.minCitations ?? 1), scope: String(d.scope ?? 'all'), maxSources: Number(d.maxSources ?? 6) };
    if (!_config.enabled) _citeMode = false;
  } catch { /* keep defaults (off) */ }
}

/** The composer toggle. Returns null when the workspace hasn't enabled cited answers. */
export function buildCiteToggle(rerender: () => void): HTMLElement | null {
  if (!_config.enabled) return null;
  return h('button', {
    type: 'button',
    className: 'cite-toggle' + (_citeMode ? ' on' : ''),
    'aria-pressed': String(_citeMode),
    title: 'Answer from your workspace (notes + past chats) with sources you can check',
    onClick: () => { _citeMode = !_citeMode; rerender(); },
  }, h('span', { 'aria-hidden': 'true' }, '❝'), ' Cite sources');
}

/**
 * Send a question through the grounded/cited path. Pushes the user turn + a placeholder assistant message,
 * then fills the placeholder with the verified answer. Returns true if it handled the send.
 */
export async function sendCitedMessage(chatId: string, question: string, rerenderMessages: () => void): Promise<void> {
  if (_citing) return;
  _citing = true;
  const q = question.trim();
  (state.messages as any[]).push({ role: 'user', content: q, created_at: new Date().toISOString() });
  const placeholder: any = { role: 'assistant', content: '', citing: true, created_at: new Date().toISOString() };
  (state.messages as any[]).push(placeholder);
  (state as any).transcriptAtBottom = true;
  rerenderMessages();
  try {
    const res = await api.post(`/api/me/chats/${encodeURIComponent(chatId)}/cite`, { question: q });
    if (!res || !(res as Response).ok) throw new Error(String((res as Response)?.status ?? 'error'));
    const d = await (res as Response).json() as { messageId?: string; answer?: string; citations?: Cite[]; sources?: any[]; grounded?: boolean; groundingNote?: string };
    placeholder.id = d.messageId;
    placeholder.content = d.answer || '';
    placeholder.citing = false;
    placeholder.metadata = JSON.stringify({ cited: true, citations: d.citations ?? [], sources: d.sources ?? [], grounded: !!d.grounded, groundingNote: d.groundingNote });
  } catch {
    placeholder.citing = false;
    placeholder.content = '';
    placeholder.errorKind = 'request';
    placeholder.errorText = 'Couldn’t build a cited answer just now. Please try again.';
    placeholder.errorRetryable = true;
  } finally {
    _citing = false;
    rerenderMessages();
  }
}

/** Open the source behind a citation. Notes navigate + highlight; other kinds are informational. */
async function openSource(c: Cite): Promise<void> {
  if (c.sourceKind !== 'note') return; // past-chat ("run") sources are shown but not navigable
  try {
    const notesView = await import('./notes-view.js');
    const wsUi = await import('./notes-workspace-ui.js');
    (state as any).view = 'notes';
    (globalThis as any).render?.();
    await notesView.loadNote(c.sourceId);
    (globalThis as any).render?.();
    if (c.quote) setTimeout(() => { try { wsUi.highlightQuoteInEditor(c.quote); } catch { /* */ } }, 500);
  } catch { /* navigation is best-effort */ }
}

/**
 * Render a cited assistant answer: the prose with each [n] as a clickable chip, then the verified source
 * cards. `grounded=false` shows a plain "not backed by your workspace" note instead of implying sources.
 */
export function renderCitedAnswer(content: string, citations: Cite[], grounded: boolean, groundingNote?: string): HTMLElement {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const answer = h('div', { className: 'chat-cite-answer' }) as HTMLElement;
  let last = 0;
  for (const m of (content ?? '').matchAll(/\[(\d+)\]/g)) {
    const i = m.index ?? 0;
    if (i > last) answer.appendChild(document.createTextNode(content.slice(last, i)));
    const n = Number(m[1]);
    const c = byN.get(n);
    answer.appendChild(h('button', {
      className: `chat-cite-chip${c ? '' : ' unmatched'}`,
      title: c ? (c.sourceKind === 'note' ? `Open “${c.sourceTitle}” and highlight the quote` : `From “${c.sourceTitle}” (past chat)`) : 'No verified source',
      ...(c && c.sourceKind === 'note' ? { onClick: () => void openSource(c) } : {}),
    }, String(n)));
    last = i + m[0].length;
  }
  if (last < (content?.length ?? 0)) answer.appendChild(document.createTextNode(content.slice(last)));

  const wrap = h('div', { className: 'chat-cite-block' }, answer) as HTMLElement;
  if (citations.length) {
    wrap.appendChild(h('div', { className: 'chat-cite-label' }, 'Sources — each quote is verified to appear in your workspace:'));
    for (const c of citations) {
      wrap.appendChild(h('div', {
        className: 'chat-cite-card' + (c.sourceKind === 'note' ? ' openable' : ''),
        ...(c.sourceKind === 'note' ? { title: 'Open the source note and highlight this exact line', onClick: () => void openSource(c) } : { title: 'From a past chat' }),
      },
        h('span', { className: 'chat-cite-n' }, `[${c.n}]`),
        h('span', { className: 'chat-cite-quote' }, `“${c.quote}”`),
        h('span', { className: 'chat-cite-src' }, `— ${c.sourceTitle}${c.sourceKind === 'run' ? ' (chat)' : ''}`),
      ));
    }
  } else {
    wrap.appendChild(h('div', { className: 'chat-cite-ungrounded', role: 'note' },
      groundingNote || 'No verifiable sources in your workspace for this answer.'));
  }
  return wrap;
}
