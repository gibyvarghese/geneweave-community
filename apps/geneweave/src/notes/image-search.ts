// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — free-to-use IMAGE SEARCH helpers (pure, no network).
 *
 * When a note asks to "show / insert a picture of X" (or "draw X" where a real picture beats AI art),
 * the app searches a free-image provider and inserts the best match WITH attribution + licence. This
 * module is the pure, unit-testable core: it builds each provider's request URL, parses its response
 * into a normalised {@link ImageResult}, and decides which results are FREE TO USE (licence policy +
 * attribution). The app layer does the actual network fetch (through the hardened/SSRF-guarded fetch)
 * and the artifact storage — so this file never touches `fetch` and stays deterministic.
 *
 * Licence model — "free to use" is NOT uniform, so every result carries its licence and we gate on it:
 *   - cc0 / pdm (public domain)  → free, NO attribution required.
 *   - by / by-sa                 → free, attribution REQUIRED (by-sa also ShareAlike).
 *   - by-nc* / by-nd*            → NOT free-to-use for us (non-commercial / no-derivatives) — excluded.
 *   - unsplash / pexels / pixabay→ free for commercial use, attribution optional (we still show it).
 */

export type ImageProvider = 'openverse' | 'wikimedia' | 'unsplash' | 'pexels' | 'pixabay';

/** Canonical licence id (lower-case). 'unknown' is never auto-allowed. */
export type LicenseId =
  | 'cc0' | 'pdm' | 'by' | 'by-sa' | 'by-nc' | 'by-nd' | 'by-nc-sa' | 'by-nc-nd'
  | 'unsplash' | 'pexels' | 'pixabay' | 'unknown';

export interface ImageResult {
  url: string;            // direct image URL (what we download)
  thumbUrl?: string;      // small preview, when the provider gives one
  title: string;
  license: LicenseId;
  licenseVersion?: string;
  licenseUrl?: string;
  creator?: string;
  sourceUrl?: string;     // landing page (for attribution link)
  provider: ImageProvider;
  mime?: string;
}

/** Licences that are FREE TO USE (incl. commercial) by default — NC/ND are intentionally excluded. */
export const DEFAULT_ALLOWED_LICENSES: LicenseId[] = ['cc0', 'pdm', 'by', 'by-sa', 'unsplash', 'pexels', 'pixabay'];
/** Public-domain-equivalent licences carry no attribution burden, so we prefer them. */
export const PUBLIC_DOMAIN_LICENSES: LicenseId[] = ['cc0', 'pdm'];

/** True when a licence legally requires showing attribution. (We still display it for the others.) */
export function requiresAttribution(license: LicenseId): boolean {
  return license !== 'cc0' && license !== 'pdm' && license !== 'unsplash' && license !== 'pexels' && license !== 'pixabay' && license !== 'unknown';
}

export function isLicenseAllowed(license: LicenseId, allowed: LicenseId[] = DEFAULT_ALLOWED_LICENSES): boolean {
  return allowed.includes(license);
}

/** Normalise any provider's licence string to a canonical {@link LicenseId}. */
export function normalizeLicense(raw: string | undefined | null): LicenseId {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'unsplash' || s === 'pexels' || s === 'pixabay') return s;
  if (/(^|[^a-z])cc0([^a-z]|$)/.test(s) || s.includes('zero')) return 'cc0';
  if (s.includes('public domain') || s === 'pdm' || s.includes('pdm') || s.includes('no known copyright')) return 'pdm';
  // Map CC codes — order matters (check the most-specific combos first).
  const has = (c: string) => new RegExp(`(^|[^a-z])${c}([^a-z]|$)`).test(s.replace(/[\s_]+/g, '-'));
  if (has('by-nc-sa')) return 'by-nc-sa';
  if (has('by-nc-nd')) return 'by-nc-nd';
  if (has('by-nc')) return 'by-nc';
  if (has('by-nd')) return 'by-nd';
  if (has('by-sa')) return 'by-sa';
  if (has('by')) return 'by';
  return 'unknown';
}

/** A short human attribution line, e.g. ‘Heart diagram’ by Wapcaplet — CC BY-SA 3.0 (via Wikimedia Commons). */
export function buildAttribution(r: ImageResult): string {
  const provider = { openverse: 'Openverse', wikimedia: 'Wikimedia Commons', unsplash: 'Unsplash', pexels: 'Pexels', pixabay: 'Pixabay' }[r.provider];
  const licName = LICENSE_LABELS[r.license] + (r.licenseVersion ? ` ${r.licenseVersion}` : '');
  const by = r.creator ? ` by ${r.creator}` : '';
  const title = r.title ? `‘${r.title}’` : 'Image';
  return `${title}${by} — ${licName} (via ${provider})`;
}

export const LICENSE_LABELS: Record<LicenseId, string> = {
  cc0: 'CC0 (public domain)', pdm: 'Public domain', by: 'CC BY', 'by-sa': 'CC BY-SA',
  'by-nc': 'CC BY-NC', 'by-nd': 'CC BY-ND', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND',
  unsplash: 'Unsplash licence', pexels: 'Pexels licence', pixabay: 'Pixabay licence', unknown: 'Unknown licence',
};

// ─── Language preference (an image's labels — esp. diagrams — may be in any language) ──────────────

/** Common image-label languages: code → English name. 'en' is the default everywhere. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', pl: 'Polish',
  sv: 'Swedish', tr: 'Turkish', fa: 'Persian', cs: 'Czech', el: 'Greek', he: 'Hebrew', uk: 'Ukrainian',
  vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', ro: 'Romanian', hu: 'Hungarian', fi: 'Finnish', da: 'Danish', no: 'Norwegian',
};
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(LANGUAGE_NAMES).map(([c, n]) => [n.toLowerCase(), c]));

/** Normalise a user language preference to a 2-letter code (default 'en'). */
export function normalizeLanguage(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'en';
  if (LANGUAGE_NAMES[s]) return s;                 // already a code
  if (NAME_TO_CODE[s]) return NAME_TO_CODE[s];     // a name → code
  const two = s.slice(0, 2);                        // e.g. 'en-gb' → 'en'
  return LANGUAGE_NAMES[two] ? two : 'en';
}

export function languageName(code: string): string { return LANGUAGE_NAMES[normalizeLanguage(code)] ?? 'English'; }

/** Detect a language SIGNALLED by a filename/title (Wikimedia diagrams often encode it), '' if none.
 *  e.g. "Heart diagram-fr.svg" → 'fr'; "Heart (German).png" → 'de'. */
export function detectTitleLanguage(title: string): string {
  const t = String(title ?? '').toLowerCase();
  const suffix = t.match(/[-_ ]([a-z]{2,3})(?:\.[a-z0-9]{2,4})?\s*$/); // ...-fr.svg / ..._de / ...-en (end)
  if (suffix && LANGUAGE_NAMES[suffix[1] as string]) return suffix[1] as string;
  for (const [name, code] of Object.entries(NAME_TO_CODE)) { if (new RegExp(`\\b${name}\\b`).test(t)) return code; }
  return '';
}

/** True when the title clearly signals a DIFFERENT language than the target (→ deprioritise it). */
export function titleLanguageMismatch(title: string, lang: string): boolean {
  const detected = detectTitleLanguage(title);
  return detected !== '' && detected !== normalizeLanguage(lang);
}

/** Stable reorder so candidates whose title is clearly ANOTHER language sink to the bottom (kept as
 *  fallbacks, not dropped — a relevant image with no language signal still ranks above a wrong-language one). */
export function applyLanguagePreference(candidates: ImageResult[], lang: string): ImageResult[] {
  return candidates
    .map((c, i) => ({ c, i, bad: titleLanguageMismatch(c.title, lang) ? 1 : 0 }))
    .sort((a, b) => a.bad - b.bad || a.i - b.i)
    .map((x) => x.c);
}

/** Keep only allowed licences, then prefer public-domain (no attribution) — stable within each tier. */
export function rankImageResults(results: ImageResult[], allowed: LicenseId[] = DEFAULT_ALLOWED_LICENSES): ImageResult[] {
  const ok = results.filter((r) => r.url && isLicenseAllowed(r.license, allowed));
  return ok
    .map((r, i) => ({ r, i, pd: PUBLIC_DOMAIN_LICENSES.includes(r.license) ? 0 : 1 }))
    .sort((a, b) => a.pd - b.pd || a.i - b.i)
    .map((x) => x.r);
}

// ─── Provider request builders (return a URL string the app fetches) ───────────────────────────────

/** Openverse — aggregates CC + public-domain images (no API key). We restrict to commercial+modifiable. */
export function buildOpenverseUrl(query: string, opts: { pageSize?: number } = {}): string {
  const u = new URL('https://api.openverse.org/v1/images/');
  u.searchParams.set('q', query);
  u.searchParams.set('license_type', 'commercial,modification'); // free-to-use + remixable only
  u.searchParams.set('page_size', String(Math.min(Math.max(opts.pageSize ?? 8, 1), 20)));
  return u.toString();
}

/** Wikimedia Commons — best for labelled medical/scientific diagrams (no API key). */
export function buildWikimediaUrl(query: string, opts: { limit?: number; thumbWidth?: number } = {}): string {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  const p = u.searchParams;
  p.set('action', 'query'); p.set('format', 'json'); p.set('generator', 'search');
  p.set('gsrsearch', query); p.set('gsrnamespace', '6'); // File:
  p.set('gsrlimit', String(Math.min(Math.max(opts.limit ?? 8, 1), 20)));
  p.set('prop', 'imageinfo'); p.set('iiprop', 'url|mime|extmetadata');
  p.set('iiurlwidth', String(opts.thumbWidth ?? 800));
  return u.toString();
}

export function buildUnsplashUrl(query: string, opts: { perPage?: number } = {}): string {
  const u = new URL('https://api.unsplash.com/search/photos');
  u.searchParams.set('query', query); u.searchParams.set('per_page', String(opts.perPage ?? 8));
  return u.toString();
}
export function buildPexelsUrl(query: string, opts: { perPage?: number } = {}): string {
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', query); u.searchParams.set('per_page', String(opts.perPage ?? 8));
  return u.toString();
}
export function buildPixabayUrl(query: string, apiKey: string, opts: { perPage?: number } = {}): string {
  const u = new URL('https://pixabay.com/api/');
  u.searchParams.set('key', apiKey); u.searchParams.set('q', query);
  u.searchParams.set('per_page', String(Math.max(opts.perPage ?? 8, 3))); u.searchParams.set('safesearch', 'true');
  return u.toString();
}

// ─── Provider response parsers (provider JSON → ImageResult[]) ──────────────────────────────────────

export function parseOpenverse(json: unknown): ImageResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const url = typeof r['url'] === 'string' ? r['url'] : '';
    if (!url) return [];
    return [{
      url,
      ...(typeof r['thumbnail'] === 'string' ? { thumbUrl: r['thumbnail'] } : {}),
      title: typeof r['title'] === 'string' ? r['title'] : 'Image',
      license: normalizeLicense(typeof r['license'] === 'string' ? r['license'] : ''),
      ...(typeof r['license_version'] === 'string' ? { licenseVersion: r['license_version'] } : {}),
      ...(typeof r['license_url'] === 'string' ? { licenseUrl: r['license_url'] } : {}),
      ...(typeof r['creator'] === 'string' ? { creator: r['creator'] } : {}),
      ...(typeof r['foreign_landing_url'] === 'string' ? { sourceUrl: r['foreign_landing_url'] } : {}),
      provider: 'openverse' as const,
      ...(typeof r['filetype'] === 'string' ? { mime: `image/${r['filetype']}` } : {}),
    }];
  });
}

export function parseWikimedia(json: unknown): ImageResult[] {
  const pages = (json as { query?: { pages?: Record<string, unknown> } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  return Object.values(pages).flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    const ii = (Array.isArray(p['imageinfo']) ? p['imageinfo'][0] : undefined) as Record<string, unknown> | undefined;
    const url = ii && typeof ii['url'] === 'string' ? ii['url'] : '';
    if (!url) return [];
    const md = (ii?.['extmetadata'] ?? {}) as Record<string, { value?: unknown }>;
    const mdv = (k: string): string | undefined => (typeof md[k]?.value === 'string' ? (md[k]!.value as string).replace(/<[^>]+>/g, '').trim() : undefined);
    return [{
      url,
      ...(typeof ii?.['thumburl'] === 'string' ? { thumbUrl: ii['thumburl'] as string } : {}),
      title: typeof p['title'] === 'string' ? (p['title'] as string).replace(/^File:/, '') : 'Image',
      license: normalizeLicense(mdv('LicenseShortName') ?? mdv('License')),
      ...(mdv('LicenseUrl') ? { licenseUrl: mdv('LicenseUrl') } : {}),
      ...(mdv('Artist') ? { creator: mdv('Artist') } : {}),
      ...(typeof p['title'] === 'string' ? { sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p['title'] as string)}` } : {}),
      provider: 'wikimedia' as const,
      ...(typeof ii?.['mime'] === 'string' ? { mime: ii['mime'] as string } : {}),
    }];
  });
}

export function parseUnsplash(json: unknown): ImageResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const url = (r['urls'] as Record<string, unknown>)?.['regular'];
    if (typeof url !== 'string') return [];
    const user = r['user'] as Record<string, unknown> | undefined;
    return [{
      url, title: typeof r['alt_description'] === 'string' ? r['alt_description'] : 'Photo', license: 'unsplash' as const,
      ...(typeof user?.['name'] === 'string' ? { creator: user['name'] as string } : {}),
      ...(typeof (r['links'] as Record<string, unknown>)?.['html'] === 'string' ? { sourceUrl: (r['links'] as Record<string, string>)['html'] } : {}),
      provider: 'unsplash' as const, mime: 'image/jpeg',
    }];
  });
}

export function parsePexels(json: unknown): ImageResult[] {
  const photos = (json as { photos?: unknown[] })?.photos;
  if (!Array.isArray(photos)) return [];
  return photos.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const url = (r['src'] as Record<string, unknown>)?.['large'];
    if (typeof url !== 'string') return [];
    return [{
      url, title: typeof r['alt'] === 'string' ? r['alt'] : 'Photo', license: 'pexels' as const,
      ...(typeof r['photographer'] === 'string' ? { creator: r['photographer'] as string } : {}),
      ...(typeof r['url'] === 'string' ? { sourceUrl: r['url'] as string } : {}),
      provider: 'pexels' as const, mime: 'image/jpeg',
    }];
  });
}

export function parsePixabay(json: unknown): ImageResult[] {
  const hits = (json as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const url = typeof r['largeImageURL'] === 'string' ? r['largeImageURL'] : (typeof r['webformatURL'] === 'string' ? r['webformatURL'] : '');
    if (!url) return [];
    return [{
      url, title: typeof r['tags'] === 'string' ? r['tags'] as string : 'Image', license: 'pixabay' as const,
      ...(typeof r['user'] === 'string' ? { creator: r['user'] as string } : {}),
      ...(typeof r['pageURL'] === 'string' ? { sourceUrl: r['pageURL'] as string } : {}),
      provider: 'pixabay' as const, mime: 'image/jpeg',
    }];
  });
}
