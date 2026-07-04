// SPDX-License-Identifier: MIT
/**
 * geneWeave brand marks (from the design system handoff).
 *
 * The WOVEN MARK is two interlaced rounded strokes in a 34×34 viewBox: the emerald strand =
 * the assistant, the ink strand = you. This is the heart of the "color encodes agency" idea —
 * wherever the AI is present (a byline, an avatar, an AI surface), the woven mark appears.
 *
 * `wovenMark(size, variant)` returns an inline SVG string (use with innerHTML / dom helpers).
 * Variants: 'duo' (emerald + ink, the default lockup), 'ai' (emerald + dim emerald — used on
 * mint surfaces and as the AI avatar), 'reversed' (bright on dark).
 */
export function wovenMarkSvg(size = 24, variant: 'duo' | 'ai' | 'reversed' = 'duo'): string {
  const [a, b, bOpacity] = variant === 'reversed'
    ? ['#2FD39B', '#E8EFEB', '0.9']
    : variant === 'ai'
      ? ['#0E9A6E', '#0B7A57', '0.55']
      : ['#0E9A6E', '#14201B', '0.9'];
  return `<svg width="${size}" height="${size}" viewBox="0 0 34 34" fill="none" aria-hidden="true">`
    + `<path d="M7 11 C 13 11, 13 23, 19 23 C 25 23, 25 11, 31 11" stroke="${a}" stroke-width="3.4" stroke-linecap="round"/>`
    + `<path d="M3 23 C 9 23, 9 11, 15 11 C 21 11, 21 23, 27 23" stroke="${b}" stroke-width="3.4" stroke-linecap="round" opacity="${bOpacity}"/>`
    + `</svg>`;
}

/** The wordmark: lowercase `gene` (muted 600) + `Weave` (ink 700). Returns inner HTML. */
export function wordmarkHtml(): string {
  return `<span style="color:var(--muted);font-weight:600;">gene</span><span style="color:var(--ink);font-weight:700;">Weave</span>`;
}
