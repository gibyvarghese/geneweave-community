// SPDX-License-Identifier: MIT
/**
 * geneWeave Notes — the right ASSISTANT rail (presentational).
 *
 * The design's hero column: tabs (Assistant / Outline / Links), the tab body, and a sticky
 * "Ask this note anything…" composer. Like the canvas module this is DUMB — it receives the
 * already-wired bodies (the AI toolbar + suggestions for Assistant, the connections panel for
 * Links) and a computed outline, and just lays them out + handles tab switching + the composer.
 */
import { h } from './dom.js';
import { wovenMarkSvg } from './notes-brand.js';

export interface OutlineItem { text: string; level: number }
export interface RightRailOpts {
  tab: 'assistant' | 'outline' | 'links';
  onTab: (t: 'assistant' | 'outline' | 'links') => void;
  /** Pre-wired bodies. */
  assistantBody: HTMLElement; // AI toolbar + pending-suggestions panel
  linksBody: HTMLElement;     // connections (backlinks / related / graph)
  outline: OutlineItem[];
  onOutlineClick: (index: number) => void;
  onComposerSend: (text: string) => void;
  composerPlaceholder: string;
}

function tab(label: string, key: 'assistant' | 'outline' | 'links', active: boolean, onTab: (t: 'assistant' | 'outline' | 'links') => void): HTMLElement {
  return h('button', { className: `gw-rail-tab${active ? ' active' : ''}`, onClick: () => onTab(key) }, label);
}

export function renderRightRail(opts: RightRailOpts): HTMLElement {
  // Tab bodies — only the active one is shown (the others stay in the DOM so wiring survives).
  opts.assistantBody.style.display = opts.tab === 'assistant' ? '' : 'none';
  opts.linksBody.style.display = opts.tab === 'links' ? '' : 'none';

  const outlineBody = h('div', { className: 'gw-rail-outline' },
    opts.outline.length === 0
      ? h('div', { className: 'gw-rail-empty' }, 'Headings in this note will appear here.')
      : h('div', { className: 'gw-outline-list' },
          ...opts.outline.map((o, i) => h('button', {
            className: `gw-outline-item lvl${o.level}`, onClick: () => opts.onOutlineClick(i),
          }, o.text || '(untitled heading)')),
        ),
  ) as HTMLElement;
  outlineBody.style.display = opts.tab === 'outline' ? '' : 'none';

  // Composer.
  const input = h('input', { className: 'gw-composer-input', type: 'text', placeholder: opts.composerPlaceholder }) as HTMLInputElement;
  const send = (): void => { const v = input.value.trim(); if (v) { input.value = ''; opts.onComposerSend(v); } };
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') send(); });

  return h('aside', { className: 'gw-rail' },
    h('div', { className: 'gw-rail-tabs' },
      tab('Assistant', 'assistant', opts.tab === 'assistant', opts.onTab),
      tab('Outline', 'outline', opts.tab === 'outline', opts.onTab),
      tab('Links', 'links', opts.tab === 'links', opts.onTab),
    ),
    h('div', { className: 'gw-rail-divider' }),
    h('div', { className: 'gw-rail-body gw-scroll' }, opts.assistantBody, outlineBody, opts.linksBody),
    h('div', { className: 'gw-composer' },
      h('div', { className: 'gw-composer-pill' },
        input,
        h('button', { className: 'gw-composer-send', title: 'Send', onClick: send, innerHTML: wovenMarkSvg(13, 'ai') }),
      ),
    ),
  );
}
