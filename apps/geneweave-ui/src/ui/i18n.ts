/**
 * Internationalisation — the client side (m145).
 *
 * The web UI is served as raw ES modules and can't bundle a workspace package, so this MIRRORS the pure
 * @weaveintel/core/i18n core (the package's tests are the canonical spec). At sign-in the app fetches the
 * effective message pack for the reader's language from GET /api/me/i18n (English base + any built-in locale
 * + the workspace's AI-generated pack, already resolved down the fallback chain), and `t(key)` looks a label
 * up in it. An unknown key returns the key itself, so a missing translation degrades gracefully.
 *
 * Keep interpolate() byte-for-byte equivalent to packages/i18n/src/i18n.ts — see that file's test suite.
 */
import { api } from './api.js';

type Catalog = Record<string, string>;

let _messages: Catalog = {};
let _locale = 'en';
let _available: { default_locale: string; assistant_localized: boolean; locales: Array<{ code: string; name: string; source: string }> } = { default_locale: 'en', assistant_localized: false, locales: [{ code: 'en', name: 'English', source: 'builtin' }] };

// ── ICU-subset interpolation (mirror of @weaveintel/core/i18n) ─────────────────────────────────

function pluralCategory(n: number, locale = 'en'): string {
  const num = typeof n === 'number' && Number.isFinite(n) ? Math.abs(n) : 0;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') return new Intl.PluralRules(locale).select(num);
  } catch { /* fall through */ }
  return num === 1 ? 'one' : 'other';
}
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
interface PluralBlock { varName: string; cases: Array<{ key: string; body: string }>; end: number }
function parsePlural(s: string, open: number): PluralBlock | null {
  const close = matchBrace(s, open);
  if (close < 0) return null;
  const inner = s.slice(open + 1, close);
  const m = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,\s*/.exec(inner);
  if (!m) return null;
  const rest = inner.slice(m[0].length);
  const cases: Array<{ key: string; body: string }> = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (i >= rest.length) break;
    const km = /^(=\d+|zero|one|two|few|many|other)/.exec(rest.slice(i));
    if (!km) break;
    i += km[0].length;
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (rest[i] !== '{') break;
    const bClose = matchBrace(rest, i);
    if (bClose < 0) break;
    cases.push({ key: km[0], body: rest.slice(i + 1, bClose) });
    i = bClose + 1;
  }
  if (!cases.length) return null;
  return { varName: m[1]!, cases, end: close + 1 };
}
function fillNamed(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
}
export function interpolate(template: unknown, params: Record<string, unknown> = {}, locale = 'en'): string {
  const src = typeof template === 'string' ? template : String(template ?? '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      const block = parsePlural(src, i);
      if (block) {
        const raw = params[block.varName];
        const n = typeof raw === 'number' ? raw : Number(raw);
        const exact = block.cases.find((c) => c.key === `=${n}`);
        const cat = pluralCategory(Number.isFinite(n) ? n : 0, locale);
        const chosen = exact ?? block.cases.find((c) => c.key === cat) ?? block.cases.find((c) => c.key === 'other') ?? block.cases[0]!;
        out += fillNamed(chosen.body.replace(/#/g, Number.isFinite(n) ? String(n) : ''), params);
        i = block.end;
        continue;
      }
    }
    out += src[i++];
  }
  return fillNamed(out, params);
}

// ── Public runtime ────────────────────────────────────────────────────────────────────────

/** Translate a key with optional params. Missing key → the key itself (graceful degradation). */
export function t(key: string, params?: Record<string, unknown>): string {
  const tpl = _messages[key];
  if (tpl == null) return key;
  return interpolate(tpl, params ?? {}, _locale);
}

export function currentLocale(): string { return _locale; }
export function availableLocales(): typeof _available { return _available; }
export function assistantLocalized(): boolean { return _available.assistant_localized; }

/**
 * Load the effective message pack for `locale` (or the reader's saved language when omitted). Safe to call
 * repeatedly (e.g. after the user changes their language in Account). Failures keep the last-known pack so
 * the UI never blanks out.
 */
export async function loadI18n(locale?: string): Promise<void> {
  try {
    const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
    const res = await api.get(`/api/me/i18n${q}`);
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as { locale?: string; messages?: Catalog; available?: typeof _available };
    if (d.messages) _messages = d.messages;
    if (d.locale) _locale = d.locale;
    if (d.available) _available = d.available;
  } catch { /* keep the previous pack (English if never loaded) */ }
}
