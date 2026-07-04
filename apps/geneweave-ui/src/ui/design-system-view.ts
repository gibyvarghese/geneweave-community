// SPDX-License-Identifier: MIT
/**
 * geneWeave DESIGN SYSTEM reference page — the in-app recreation of
 * "GeneWeave Design System.dc.html". It is the living source of truth for the visual
 * language: the principle ("color encodes agency"), the woven mark, the colour tokens,
 * the type roles, spacing/shape, buttons & forms, the agent action card, and the
 * plain-language copy rules. Everything reads from the SAME CSS tokens the rest of the
 * app uses (var(--accent), var(--mint), var(--ink)…), so this page can never drift from
 * production — if a token changes, this page changes with it.
 *
 * A single scrolling document (max-width 1040px, centred) on the canvas background.
 */
import { h } from './dom.js';
import { wovenMarkSvg, wordmarkHtml } from './notes-brand.js';

function eyebrow(text: string): HTMLElement { return h('div', { className: 'ds-eyebrow' }, text); }
function section(num: string, title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h('section', { className: 'ds-section' }, eyebrow(num), h('h2', { className: 'ds-h2' }, title), ...body.filter(Boolean) as HTMLElement[]);
}
function swatch(name: string, cssVar: string, hex: string, use: string): HTMLElement {
  return h('div', { className: 'ds-swatch' },
    h('div', { className: 'ds-swatch-chip', style: `background:var(${cssVar})` }),
    h('div', { className: 'ds-swatch-meta' },
      h('div', { className: 'ds-swatch-name' }, name),
      h('div', { className: 'ds-swatch-hex' }, hex),
      h('div', { className: 'ds-swatch-use' }, use),
    ),
  );
}

export function renderDesignSystemView(render: () => void): HTMLElement {
  void render;
  const doc = h('div', { className: 'ds-doc' },
    // ── Cover ──
    h('div', { className: 'ds-cover' },
      h('div', { className: 'ds-brand' }, h('span', { className: 'ds-brand-mark', innerHTML: wovenMarkSvg(28, 'duo') }), h('span', { className: 'ds-brand-word', innerHTML: wordmarkHtml() })),
      eyebrow('Design system · v1.0'),
      h('h1', { className: 'ds-display' }, 'A calm surface you inhabit all day.'),
      h('p', { className: 'ds-lead' }, 'The visual language for an ambient, conversation-first AI assistant. Disciplined neutrals for what you own; a soft emerald-mint signal wherever the assistant has left its fingerprints.'),
      h('div', { className: 'ds-chips' },
        h('span', { className: 'ds-chip' }, 'Calm'), h('span', { className: 'ds-chip' }, 'Spacious'), h('span', { className: 'ds-chip' }, 'Alive'),
        h('span', { className: 'ds-chip ds-chip-ai' }, 'Ambient AI'),
      ),
    ),

    // ── 01 Principle ──
    section('01 · Principle', 'Color encodes agency',
      h('div', { className: 'ds-two' },
        h('div', { className: 'ds-card' },
          h('div', { className: 'ds-card-head' }, h('span', { className: 'ds-ink-square' }), h('span', { className: 'ds-card-title' }, 'What you own')),
          h('p', { className: 'ds-card-body' }, 'Your notes, your messages, your day — all rendered in calm neutrals. Paper-white surfaces, ink text, soft grey labels. Nothing competes for attention.'),
          h('div', { className: 'ds-bubble ds-bubble-you' }, 'Move my 2pm to Thursday'),
        ),
        h('div', { className: 'ds-card ds-card-ai' },
          h('div', { className: 'ds-card-head' }, h('span', { className: 'ds-ai-square', innerHTML: wovenMarkSvg(14, 'ai') }), h('span', { className: 'ds-card-title' }, 'What the assistant touches')),
          h('p', { className: 'ds-card-body' }, 'Agent messages, action cards, and any object the AI created wear a faint mint aura and a woven mark — so you can scan a screen and see the assistant’s fingerprints on your day.'),
          h('div', { className: 'ds-bubble ds-bubble-ai' }, 'Done — moved to Thursday 2pm.'),
        ),
      ),
    ),

    // ── 02 Logo ──
    section('02 · Logo & wordmark', 'The woven mark',
      h('div', { className: 'ds-logo-row' },
        h('div', { className: 'ds-lockup' }, h('span', { innerHTML: wovenMarkSvg(40, 'duo') }), h('div', { className: 'ds-lockup-cap' }, 'Primary')),
        h('div', { className: 'ds-lockup ds-lockup-mint' }, h('span', { innerHTML: wovenMarkSvg(40, 'ai') }), h('div', { className: 'ds-lockup-cap' }, 'On mint')),
        h('div', { className: 'ds-lockup ds-lockup-ink' }, h('span', { innerHTML: wovenMarkSvg(40, 'reversed') }), h('div', { className: 'ds-lockup-cap ds-cap-rev' }, 'Reversed')),
      ),
      h('p', { className: 'ds-note' }, 'Two interlaced strokes: the emerald strand is the assistant, the ink strand is you. The wordmark is lowercase “gene” in muted 600 + “Weave” in ink 700 — always a lowercase g.'),
    ),

    // ── 03 Color ──
    section('03 · Color', 'Tokens',
      h('div', { className: 'ds-swatch-label' }, 'Neutrals'),
      h('div', { className: 'ds-swatch-grid' },
        swatch('canvas', '--canvas', '#F6F8F7', 'App background'),
        swatch('surface', '--surface', '#FFFFFF', 'Cards, panels, rails'),
        swatch('ink', '--ink', '#14201B', 'Primary text'),
        swatch('muted', '--muted', '#5E6E67', 'Secondary text, labels'),
        swatch('hairline', '--hairline', '#E7ECEA', 'Borders, dividers'),
        swatch('paper', '--paper', '#FBF8F1', 'Notes page (Creative)'),
      ),
      h('div', { className: 'ds-swatch-label' }, 'Signal — emerald = the assistant + primary action'),
      h('div', { className: 'ds-swatch-grid' },
        swatch('emerald', '--accent', '#0E9A6E', 'Primary action + AI presence'),
        swatch('emerald-press', '--accent2', '#0B7A57', 'Pressed, text on mint'),
        swatch('mint', '--mint', '#E8F5EE', 'AI surfaces, active rows'),
        swatch('mint-deep', '--mint-deep', '#DCEFE5', 'Mint hover/borders'),
        swatch('amber', '--amber', '#D98A3D', 'Attention only'),
        swatch('coral', '--coral', '#D85A30', 'Human ink / doodles'),
      ),
    ),

    // ── 04 Typography ──
    section('04 · Typography', 'Three roles, sentence case',
      h('div', { className: 'ds-type-row' },
        h('div', { className: 'ds-type-card' }, h('div', { className: 'ds-type-sample ds-type-display' }, 'Display'), h('div', { className: 'ds-type-meta' }, 'Plus Jakarta Sans · 800 · headings')),
        h('div', { className: 'ds-type-card' }, h('div', { className: 'ds-type-sample ds-type-body' }, 'Body & UI'), h('div', { className: 'ds-type-meta' }, 'Inter · 400/500/600')),
        h('div', { className: 'ds-type-card' }, h('div', { className: 'ds-type-sample ds-type-mono' }, 'meta · code · keys'), h('div', { className: 'ds-type-meta' }, 'JetBrains Mono · 400/500')),
      ),
      h('p', { className: 'ds-note' }, 'Handwriting (Caveat) is reserved for the Notes Creative mode — titles, diagram labels, doodles. Sentence case everywhere.'),
    ),

    // ── 05 Spacing & shape ──
    section('05 · Spacing, shape & depth', 'An 8px grid, soft corners, almost no shadow',
      h('div', { className: 'ds-scale' },
        ...[['8', '8 · inline'], ['16', '16 · element'], ['24', '24 · card padding'], ['32', '32 · section padding'], ['80', '80 · section rhythm']].map(([w, label]) =>
          h('div', { className: 'ds-scale-row' }, h('div', { className: 'ds-scale-bar', style: `width:${w}px` }), h('span', { className: 'ds-scale-cap' }, label))),
      ),
      h('div', { className: 'ds-radius-row' },
        h('div', { className: 'ds-radius', style: 'border-radius:12px' }, '12'),
        h('div', { className: 'ds-radius', style: 'border-radius:16px' }, '16'),
        h('div', { className: 'ds-radius', style: 'border-radius:999px' }, 'full'),
      ),
    ),

    // ── 06 Buttons & forms ──
    section('06 · Buttons & forms', 'One filled action per view',
      h('div', { className: 'ds-btn-row' },
        h('button', { className: 'ds-btn ds-btn-primary' }, 'Save'),
        h('button', { className: 'ds-btn ds-btn-ghost' }, 'Cancel'),
        h('button', { className: 'ds-btn ds-btn-mint' }, h('span', { innerHTML: wovenMarkSvg(13, 'ai') }), ' Ask AI'),
      ),
      h('div', { className: 'ds-field-row' },
        h('input', { className: 'ds-input', type: 'text', placeholder: 'A calm text field' }),
        h('div', { className: 'ds-pill-on' }, 'On'),
        h('div', { className: 'ds-pill-off' }, 'Off'),
      ),
    ),

    // ── 07 Cards & data display ──
    section('07 · Cards & data display', 'The agent action card & friends',
      h('div', { className: 'ds-action-card' },
        h('div', { className: 'ds-action-byline' }, h('span', { innerHTML: wovenMarkSvg(14, 'ai') }), h('span', null, 'geneWeave AI')),
        h('div', { className: 'ds-action-body' }, 'Moved your 2pm to Thursday and let the attendees know.'),
        h('div', { className: 'ds-action-foot' }, h('span', { className: 'ds-done-dot' }), 'Done · 1.2s · view steps ›'),
      ),
    ),

    // ── 08 Plain language ──
    section('08 · Plain language', 'Name things by what they do',
      h('div', { className: 'ds-table' },
        h('div', { className: 'ds-table-head' }, h('span', null, 'System internal'), h('span', null, 'User-facing')),
        ...[['Fragment', 'Building block'], ['key', 'Shortcut'], ['Variables (JSON)', 'Fill-in values'], ['enabled: true', 'Active · On'], ['Orchestration', 'Workflows']].map(([a, b]) =>
          h('div', { className: 'ds-table-row' }, h('span', { className: 'ds-table-from' }, a), h('span', { className: 'ds-table-arrow' }, '→'), h('span', { className: 'ds-table-to' }, b))),
      ),
    ),
  );

  return h('div', { className: 'gw-notes ds-root' }, h('div', { className: 'ds-scroll gw-scroll' }, doc));
}
