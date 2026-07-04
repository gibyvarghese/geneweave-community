/**
 * Regenerate an answer, keeping version history (m139) — the chat-side UI.
 *
 * On a settled assistant answer we add a ↻ Regenerate control (when the workspace enables it) and, once an
 * answer has more than one version, a "‹ 2/3 ›" pager. Regenerating asks the server for a fresh alternative
 * WITHOUT discarding the old one; paging switches which version is shown — losslessly. The variant list for a
 * message is cached on the message object (`_variants`) so it survives the transcript's re-render, and is
 * lazily hydrated from the server for answers that already have history when a chat is reopened.
 */
import { h } from './dom.js';
import { api } from './api.js';

interface VariantView { id: string; content: string; model: string | null; provider: string | null; reason: string | null }
interface Label { index: number; total: number; text: string; show: boolean }
interface VariantState { variants: VariantView[]; activeIndex: number; label: Label }

let _enabled = false;
const _busy = new Set<string>();          // message ids currently regenerating
const _hydrated = new Set<string>();      // message ids whose versions we've already fetched

export function isVersionsEnabled(): boolean { return _enabled; }

export async function loadAnswerVersionsConfig(): Promise<void> {
  try {
    const res = await api.get('/api/me/answer-versions');
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as { enabled?: boolean };
    _enabled = !!d.enabled;
  } catch { /* keep off */ }
}

function metaOf(m: any): Record<string, unknown> {
  const raw = m?.metadata;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function apply(m: any, chatId: string, index: number, rerender: () => void): Promise<void> {
  const res = await api.post(`/api/me/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(m.id)}/select-version`, { index });
  if (!res || !(res as Response).ok) return;
  const d = await (res as Response).json() as { content?: string; activeIndex?: number; label?: Label };
  m.content = d.content ?? m.content;
  if (m._variants) { m._variants.activeIndex = d.activeIndex ?? m._variants.activeIndex; if (d.label) m._variants.label = d.label; }
  rerender();
}

async function regenerate(m: any, chatId: string, rerender: () => void): Promise<void> {
  if (!m?.id || _busy.has(m.id)) return;
  _busy.add(m.id);
  rerender();
  try {
    const res = await api.post(`/api/me/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(m.id)}/regenerate`, {});
    if (res && (res as Response).ok) {
      const d = await (res as Response).json() as { content?: string; variants?: VariantView[]; activeIndex?: number; label?: Label };
      m.content = d.content ?? m.content;
      m._variants = { variants: d.variants ?? [], activeIndex: d.activeIndex ?? 0, label: d.label ?? { index: 0, total: 0, text: '', show: false } } as VariantState;
    }
  } catch { /* leave the answer as-is */ }
  finally { _busy.delete(m.id); rerender(); }
}

async function hydrate(m: any, chatId: string, rerender: () => void): Promise<void> {
  if (_hydrated.has(m.id)) return;
  _hydrated.add(m.id);
  try {
    const res = await api.get(`/api/me/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(m.id)}/versions`);
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as { variants?: VariantView[]; activeIndex?: number; label?: Label };
    if ((d.variants?.length ?? 0) > 1) {
      m._variants = { variants: d.variants ?? [], activeIndex: d.activeIndex ?? 0, label: d.label ?? { index: 0, total: 0, text: '', show: false } } as VariantState;
      rerender();
    }
  } catch { /* */ }
}

/**
 * The Regenerate control + version pager for one assistant answer. Returns null when versions are disabled
 * or the message isn't a persisted answer.
 */
export function buildVersionControls(m: any, chatId: string, rerender: () => void): HTMLElement | null {
  if (!_enabled || !m?.id || !m.content) return null;
  // Lazily fetch history for an answer that was regenerated in a previous session (metadata says so).
  if (!m._variants && (metaOf(m)['variantActiveId'] || metaOf(m)['regenerated']) && chatId) void hydrate(m, chatId, rerender);

  const busy = _busy.has(m.id);
  const vs: VariantState | undefined = m._variants;
  const wrap = h('div', { className: 'ver-wrap' }) as HTMLElement;

  if (vs && vs.label.show) {
    wrap.appendChild(h('button', {
      className: 'ver-nav', type: 'button', 'aria-label': 'Previous version', title: 'Previous version',
      ...(vs.label.index > 1 ? { onClick: () => void apply(m, chatId, vs.activeIndex - 1, rerender) } : { disabled: true }),
    }, '‹'));
    wrap.appendChild(h('span', { className: 'ver-count', 'aria-live': 'polite' }, vs.label.text));
    wrap.appendChild(h('button', {
      className: 'ver-nav', type: 'button', 'aria-label': 'Next version', title: 'Next version',
      ...(vs.label.index < vs.label.total ? { onClick: () => void apply(m, chatId, vs.activeIndex + 1, rerender) } : { disabled: true }),
    }, '›'));
  }

  wrap.appendChild(h('button', {
    className: 'tb-btn ver-regen' + (busy ? ' busy' : ''), type: 'button',
    'aria-label': 'Regenerate answer', title: 'Generate a different answer (keeps this one)',
    ...(busy ? { disabled: true } : { onClick: () => void regenerate(m, chatId, rerender) }),
  }, busy ? '↻ Regenerating…' : '↻ Regenerate'));

  return wrap;
}
