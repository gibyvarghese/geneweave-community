/**
 * icons.ts — the app's single icon set.
 *
 * geneWeave's branding uses one icon language everywhere: inline, line-drawn ("stroke") SVGs — the same look
 * as the left navigation (Lucide-style: a 24×24 grid, no fill, `currentColor` stroke at 1.8 width, rounded
 * caps/joins). Emoji glyphs (🖼 📝 ⋯) don't match that language — they're full-colour, inconsistent across
 * platforms, and can't inherit the current text colour — so menus should use these icons instead.
 *
 * `icon(name)` returns the SVG markup (drop into `innerHTML`); `iconEl(name, cls)` returns a ready `<span>`.
 * Because every icon inherits `currentColor`, it automatically takes the right tone in any context (muted in a
 * menu, emerald on hover, red on a destructive row) with no per-icon colours to maintain.
 */
import { h } from './dom.js';

const OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** The raw path markup for each icon (wrapped by `icon()`), all on the same 24×24 stroke grid. */
const PATHS: Record<string, string> = {
  // — left navigation (shared with the sidebar) —
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.8V21h13V9.8"/><path d="M9.5 21v-6h5v6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  notes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  design: '<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="10.5" r="2.5"/><circle cx="17" cy="15" r="2.5"/><path d="M8.5 9 11 8M9 12l5.5 2"/>',
  builder: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.2"/><rect x="13" y="3" width="8" height="5" rx="1.2"/><rect x="13" y="10" width="8" height="11" rx="1.2"/><rect x="3" y="13" width="8" height="8" rx="1.2"/>',
  connectors: '<path d="M7 7h4a2 2 0 0 1 2 2v0"/><path d="M17 17h-4a2 2 0 0 1-2-2v0"/><rect x="3" y="4" width="4" height="6" rx="1.2"/><rect x="17" y="14" width="4" height="6" rx="1.2"/>',
  admin: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a1.7 1.7 0 1 1-3.4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a1.7 1.7 0 1 1 0-3.4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1 1 0 0 0 1.1.2h0a1 1 0 0 0 .6-.9V4a1.7 1.7 0 1 1 3.4 0v.2a1 1 0 0 0 .6.9h0a1 1 0 0 0 1.1-.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1 1 0 0 0-.2 1.1v0a1 1 0 0 0 .9.6H20a1.7 1.7 0 1 1 0 3.4h-.2a1 1 0 0 0-.9.6z"/>',

  // — Insert menu —
  'file-plus': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>',
  zap: '<path d="M13 2 4 13h7l-1 9 9-11h-7l1-9z"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  brain: '<path d="M12 5a3 3 0 0 0-5.5-1.6A3 3 0 0 0 4 8a3 3 0 0 0 .5 4.5A3 3 0 0 0 8 17a2.5 2.5 0 0 0 4 .8"/><path d="M12 5a3 3 0 0 1 5.5-1.6A3 3 0 0 1 20 8a3 3 0 0 1-.5 4.5A3 3 0 0 1 16 17a2.5 2.5 0 0 1-4 .8"/><path d="M12 5v13.8"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18 15l.7 1.9L21 18l-2.3.6L18 21l-.7-2.3L15 18l2.3-.6z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>',
  languages: '<path d="M4 5h9"/><path d="M8 3v2c0 4-2 7-5 8"/><path d="M6 9c0 3 3 5 6 6"/><path d="M13 19l4-9 4 9"/><path d="M14.5 16h5"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0V8z"/><path d="M12 16v6"/>',

  // — overflow (⋯) menu —
  star: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.2l1-5.8L3.5 9.5l5.9-.9z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
  message: '<path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 21l1.3-4.5A8 8 0 1 1 21 11.5z"/>',
  sync: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  'check-square': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',

  // — note templates —
  columns: '<rect x="3" y="4" width="7" height="16" rx="1.2"/><rect x="14" y="4" width="7" height="16" rx="1.2"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/>',
  'book-open': '<path d="M12 6.5C10.5 5 8 4.5 3 5v13c5-.5 7.5 0 9 1.5"/><path d="M12 6.5C13.5 5 16 4.5 21 5v13c-5-.5-7.5 0-9 1.5z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
  'mind-map': '<circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7.2 12h3.3M10.5 12l6.4-5M10.5 12l6.4 5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M4 21h16"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h6"/>',
  ruler: '<path d="M3 15 15 3l6 6L9 21z"/><path d="m7.5 10.5 2 2M11 7l1.5 1.5M14.5 10.5l1.5 1.5"/>',
  scale: '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 6h14l-2 5"/><path d="M7 11 5 6 3 11a2.5 2.5 0 0 0 4 0z"/><path d="M21 11l-2-5-2 5a2.5 2.5 0 0 0 4 0z"/>',
  'alert-triangle': '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  package: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4 13 13l-4.6 2.6L11 11z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.5-4.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M17.5 14.5a6.5 6.5 0 0 1 4 6.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2s-.6-1.3-.6-2 .6-1 1.6-1H18a3 3 0 0 0 3-3 8 8 0 0 0-9-7z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7.5" r="1" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/>',
  lightbulb: '<path d="M9.5 18h5"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.8 10.6c.6.5 1.3 1.4 1.3 2.4h5c0-1 .7-1.9 1.3-2.4A6 6 0 0 0 12 3z"/>',
  'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.4 2.4 0 0 1 4.4 1.3c0 1.4-1.9 1.9-1.9 3"/><path d="M12 17h.01"/>',
  feather: '<path d="M20 4a6 6 0 0 0-8.5 0L5 11v8h8l6.5-6.5A6 6 0 0 0 20 4z"/><path d="M16 8 4 20"/><path d="M11 9h4M9 12h4"/>',
};

export type IconName = keyof typeof PATHS;

/** The SVG markup for an icon (for `innerHTML`). Unknown names fall back to a neutral dot so nothing crashes. */
export function icon(name: IconName | string): string {
  const p = PATHS[name as string];
  return p ? `${OPEN}${p}</svg>` : `${OPEN}<circle cx="12" cy="12" r="2"/></svg>`;
}

/** A ready `<span class="…">` wrapping the icon (defaults to the sidebar's `side-icon` class). */
export function iconEl(name: IconName | string, className = 'side-icon'): HTMLElement {
  return h('span', { className, innerHTML: icon(name) }) as HTMLElement;
}

/** True if a string is already SVG markup (so menu renderers can tell an icon from an emoji/text glyph). */
export function isSvgMarkup(s: unknown): boolean {
  return typeof s === 'string' && s.trimStart().startsWith('<svg');
}

// ── Note-template icons ──────────────────────────────────────────────────────────────────
// Map each system template (by its stable key) to a branded icon, so the template gallery uses the app's icon
// language instead of emoji. A category fallback covers user-made / unknown templates.
const TEMPLATE_ICON_BY_KEY: Record<string, string> = {
  blank: 'file-plus', cornell: 'columns', 'meeting-minutes': 'clipboard', 'study-sheet': 'book-open',
  'active-recall': 'brain', outline: 'list', 'mind-map': 'mind-map', comparison: 'columns',
  zettelkasten: 'link', 'action-board': 'grid', 'daily-planner': 'calendar', 'project-brief': 'clipboard',
  'solution-architecture': 'building', 'technical-design': 'ruler', adr: 'scale', postmortem: 'alert-triangle',
  runbook: 'book-open', prd: 'package', roadmap: 'map', 'customer-journey': 'compass', 'user-research': 'search',
  personas: 'user', 'competitive-analysis': 'target', 'design-doc': 'palette', 'design-critique': 'message',
  'one-on-one': 'users', retro: 'sync', standup: 'sun', brainstorm: 'lightbulb', okrs: 'target', swot: 'grid',
  'how-to': 'book-open', faq: 'help-circle', journal: 'feather', 'book-notes': 'book-open',
};
const TEMPLATE_ICON_BY_CATEGORY: Record<string, string> = {
  Blank: 'file-plus', Engineering: 'building', Product: 'package', Design: 'palette', Planning: 'target',
  Meetings: 'users', Knowledge: 'book-open', Thinking: 'mind-map', Study: 'book-open', Personal: 'feather', More: 'notes',
};

/** The branded icon markup for a template, chosen by its key (then category), falling back to the notes icon. */
export function templateIcon(key?: string | null, category?: string | null): string {
  if (key && TEMPLATE_ICON_BY_KEY[key]) return icon(TEMPLATE_ICON_BY_KEY[key]!);
  if (category && TEMPLATE_ICON_BY_CATEGORY[category]) return icon(TEMPLATE_ICON_BY_CATEGORY[category]!);
  return icon('notes');
}
