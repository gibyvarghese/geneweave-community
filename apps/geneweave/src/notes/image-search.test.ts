import { describe, it, expect } from 'vitest';
import {
  normalizeLicense, isLicenseAllowed, requiresAttribution, rankImageResults, buildAttribution,
  buildOpenverseUrl, buildWikimediaUrl, buildPixabayUrl, parseOpenverse, parseWikimedia, parsePexels,
  DEFAULT_ALLOWED_LICENSES, type ImageResult,
  normalizeLanguage, languageName, detectTitleLanguage, titleLanguageMismatch, applyLanguagePreference,
} from './image-search.js';

describe('image-search — licence normalisation', () => {
  it('maps provider licence strings to canonical ids', () => {
    expect(normalizeLicense('CC0')).toBe('cc0');
    expect(normalizeLicense('CC0 1.0')).toBe('cc0');
    expect(normalizeLicense('Public domain')).toBe('pdm');
    expect(normalizeLicense('pdm')).toBe('pdm');
    expect(normalizeLicense('CC BY-SA 3.0')).toBe('by-sa');
    expect(normalizeLicense('by-sa')).toBe('by-sa');
    expect(normalizeLicense('CC BY 4.0')).toBe('by');
    expect(normalizeLicense('CC BY-NC 2.0')).toBe('by-nc');
    expect(normalizeLicense('CC BY-NC-SA')).toBe('by-nc-sa');
    expect(normalizeLicense('CC BY-ND')).toBe('by-nd');
    expect(normalizeLicense('unsplash')).toBe('unsplash');
    expect(normalizeLicense('')).toBe('unknown');
    expect(normalizeLicense('All rights reserved')).toBe('unknown');
  });

  it('only public-domain licences skip attribution; NC/ND are not free-to-use by default', () => {
    expect(requiresAttribution('cc0')).toBe(false);
    expect(requiresAttribution('pdm')).toBe(false);
    expect(requiresAttribution('by')).toBe(true);
    expect(requiresAttribution('by-sa')).toBe(true);
    expect(isLicenseAllowed('cc0')).toBe(true);
    expect(isLicenseAllowed('by-sa')).toBe(true);
    expect(isLicenseAllowed('by-nc')).toBe(false); // non-commercial excluded
    expect(isLicenseAllowed('by-nd')).toBe(false); // no-derivatives excluded
    expect(isLicenseAllowed('unknown')).toBe(false);
  });
});

describe('image-search — ranking + attribution', () => {
  const mk = (license: ImageResult['license'], url = 'https://x/y.jpg'): ImageResult => ({ url, title: 't', license, provider: 'openverse' });
  it('drops disallowed licences and prefers public-domain', () => {
    const ranked = rankImageResults([mk('by'), mk('by-nc'), mk('cc0'), mk('unknown')]);
    expect(ranked.map((r) => r.license)).toEqual(['cc0', 'by']); // nc + unknown dropped, cc0 first
  });
  it('respects a custom allow-list', () => {
    const ranked = rankImageResults([mk('by'), mk('cc0')], ['by']);
    expect(ranked.map((r) => r.license)).toEqual(['by']);
  });
  it('builds a human attribution line', () => {
    const r: ImageResult = { url: 'https://x', title: 'Heart diagram', creator: 'Wapcaplet', license: 'by-sa', licenseVersion: '3.0', provider: 'wikimedia' };
    expect(buildAttribution(r)).toBe('‘Heart diagram’ by Wapcaplet — CC BY-SA 3.0 (via Wikimedia Commons)');
  });
});

describe('image-search — provider request builders', () => {
  it('Openverse restricts to commercial + modifiable and caps page size', () => {
    const u = new URL(buildOpenverseUrl('human heart', { pageSize: 50 }));
    expect(u.origin + u.pathname).toBe('https://api.openverse.org/v1/images/');
    expect(u.searchParams.get('q')).toBe('human heart');
    expect(u.searchParams.get('license_type')).toBe('commercial,modification');
    expect(u.searchParams.get('page_size')).toBe('20'); // clamped
  });
  it('Wikimedia searches the File: namespace with imageinfo', () => {
    const u = new URL(buildWikimediaUrl('diagram of the human heart'));
    expect(u.searchParams.get('gsrnamespace')).toBe('6');
    expect(u.searchParams.get('prop')).toBe('imageinfo');
    expect(u.searchParams.get('gsrsearch')).toBe('diagram of the human heart');
  });
  it('Pixabay puts the key + query on the URL', () => {
    const u = new URL(buildPixabayUrl('cat', 'KEY123'));
    expect(u.searchParams.get('key')).toBe('KEY123');
    expect(u.searchParams.get('q')).toBe('cat');
    expect(u.searchParams.get('safesearch')).toBe('true');
  });
});

describe('image-search — response parsers', () => {
  it('parses Openverse results with licence + attribution fields', () => {
    const json = { results: [{ url: 'https://img/1.jpg', thumbnail: 'https://img/t.jpg', title: 'Heart', creator: 'Dr X', license: 'by-sa', license_version: '4.0', license_url: 'https://cc/by-sa', foreign_landing_url: 'https://src/1', filetype: 'jpg' }] };
    const [r] = parseOpenverse(json);
    expect(r!.url).toBe('https://img/1.jpg');
    expect(r!.license).toBe('by-sa');
    expect(r!.licenseVersion).toBe('4.0');
    expect(r!.creator).toBe('Dr X');
    expect(r!.sourceUrl).toBe('https://src/1');
    expect(r!.provider).toBe('openverse');
  });
  it('parses Wikimedia imageinfo + extmetadata (strips HTML in artist)', () => {
    const json = { query: { pages: { '42': { title: 'File:Heart diagram-en.svg', imageinfo: [{ url: 'https://upload/heart.svg', mime: 'image/svg+xml', extmetadata: { LicenseShortName: { value: 'CC BY-SA 3.0' }, Artist: { value: '<a href="x">Wapcaplet</a>' } } }] } } } };
    const [r] = parseWikimedia(json);
    expect(r!.url).toBe('https://upload/heart.svg');
    expect(r!.license).toBe('by-sa');
    expect(r!.creator).toBe('Wapcaplet');
    expect(r!.title).toBe('Heart diagram-en.svg');
    expect(r!.sourceUrl).toContain('commons.wikimedia.org/wiki/');
  });
  it('parses Pexels photos as the pexels licence', () => {
    const json = { photos: [{ src: { large: 'https://pex/large.jpg' }, url: 'https://pex/page', photographer: 'Jane', alt: 'a cat' }] };
    const [r] = parsePexels(json);
    expect(r!.url).toBe('https://pex/large.jpg');
    expect(r!.license).toBe('pexels');
    expect(r!.creator).toBe('Jane');
  });
  it('returns [] for malformed responses', () => {
    expect(parseOpenverse({})).toEqual([]);
    expect(parseWikimedia(null)).toEqual([]);
    expect(parsePexels({ photos: 'nope' })).toEqual([]);
  });

  it('the default allow-list is exactly the free-to-use set (no NC/ND)', () => {
    expect(DEFAULT_ALLOWED_LICENSES).toEqual(['cc0', 'pdm', 'by', 'by-sa', 'unsplash', 'pexels', 'pixabay']);
  });
});

describe('image-search — language preference (default English)', () => {
  it('normalises codes / names / locales, defaulting to en', () => {
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('FR')).toBe('fr');
    expect(normalizeLanguage('German')).toBe('de');
    expect(normalizeLanguage('en-GB')).toBe('en');
    expect(normalizeLanguage('klingon')).toBe('en'); // unknown → default
    expect(languageName('de')).toBe('German');
    expect(languageName('xx')).toBe('English');
  });
  it('detects a language signalled by a filename/title', () => {
    expect(detectTitleLanguage('Heart diagram-fr.svg')).toBe('fr');
    expect(detectTitleLanguage('Heart_diagram_de.png')).toBe('de');
    expect(detectTitleLanguage('Diagram of the heart (German)')).toBe('de');
    expect(detectTitleLanguage('Heart diagram-en.svg')).toBe('en');
    expect(detectTitleLanguage('Anatomy of the heart')).toBe(''); // no signal
  });
  it('flags a clear other-language title as a mismatch', () => {
    expect(titleLanguageMismatch('Heart diagram-fr.svg', 'en')).toBe(true);
    expect(titleLanguageMismatch('Heart diagram-en.svg', 'en')).toBe(false);
    expect(titleLanguageMismatch('Anatomy of the heart', 'en')).toBe(false); // neutral, not penalised
    expect(titleLanguageMismatch('Coeur humain-fr.svg', 'fr')).toBe(false);  // matches target
  });
  it('sinks clear other-language images below same/neutral ones (kept as fallbacks)', () => {
    const mk = (title: string): ImageResult => ({ url: `https://x/${title}`, title, license: 'cc0', provider: 'wikimedia' });
    const out = applyLanguagePreference([mk('Heart-fr.svg'), mk('Anatomy of the heart'), mk('Heart-de.png'), mk('Heart-en.svg')], 'en');
    // English + neutral first (original order preserved), other-languages last.
    expect(out.map((r) => r.title)).toEqual(['Anatomy of the heart', 'Heart-en.svg', 'Heart-fr.svg', 'Heart-de.png']);
  });
});
