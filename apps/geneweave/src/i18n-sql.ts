// SPDX-License-Identifier: MIT
/**
 * i18n-sql.ts — Internationalisation service (m145, Round 9).
 *
 * Ties the pure @weaveintel/core/i18n core (locale fallback) + the shared UI catalog (ui-i18n-catalog.ts) to the
 * app and database. Three jobs:
 *
 *   1. getEffectiveCatalog(locale, tenantId) — the messages the web UI should show a reader: the base English
 *      strings, overlaid by any built-in locale (Spanish) and then the workspace's AI-generated locale pack,
 *      resolved down the BCP-47 fallback chain (fr-CA → fr → en) so a partial translation still works.
 *
 *   2. getConfig / updateConfig — the per-tenant policy (tenant_locales): default language, which languages
 *      members may pick, and whether the assistant should reply in the reader's interface language.
 *
 *   3. translateUi — localise the WHOLE UI catalog into a new language by REUSING the notes faithful-
 *      translation engine (packages/notes translate.ts: placeholder protection + injection spotlighting +
 *      verification). The English source strings become a numbered document, translated in one pass, realigned
 *      by their markers, verified, and stored as that workspace's locale pack. This is the translate_ui tool.
 */
import {
  resolveLanguage, protectNonTranslatable, restoreProtected,
  buildTranslatePrompt, parseTranslation, verifyTranslation,
  TARGET_LANGUAGES,
} from '@weaveintel/prompts';
import { resolveLocaleChain } from '@weaveintel/core/i18n';
import { EN_MESSAGES, BUILTIN_MESSAGES, BASE_LOCALE, type Catalog } from './ui-i18n-catalog.js';
import type { DatabaseAdapter } from './db.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { TenantLocalesRow, TenantUiTranslationRow } from './db-types/adapter-me.js';

const DEFAULT_TENANT = 'default';

function defaultConfig(tenantId: string): TenantLocalesRow {
  return { tenant_id: tenantId, default_locale: BASE_LOCALE, enabled_locales: '["en","es"]', assistant_localized: 0, updated_at: '' };
}

/** Parse a JSON array of locale codes; always includes the base + default; deduped. */
function parseEnabled(json: string, defaultLocale: string): string[] {
  let arr: unknown = [];
  try { arr = JSON.parse(json); } catch { /* ignore */ }
  const list = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  return [...new Set([BASE_LOCALE, defaultLocale, ...list])];
}

export function createI18nService(db: DatabaseAdapter, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  async function getConfig(tenantId: string | null): Promise<TenantLocalesRow> {
    const id = tenantId ?? DEFAULT_TENANT;
    return (await db.getTenantLocales(id)) ?? defaultConfig(id);
  }

  async function updateConfig(tenantId: string | null, patch: Partial<TenantLocalesRow>): Promise<TenantLocalesRow> {
    const id = tenantId ?? DEFAULT_TENANT;
    const cur = await getConfig(id);
    let enabled = cur.enabled_locales;
    if (patch.enabled_locales !== undefined) {
      const codes = parseEnabled(typeof patch.enabled_locales === 'string' ? patch.enabled_locales : JSON.stringify(patch.enabled_locales), patch.default_locale ?? cur.default_locale);
      enabled = JSON.stringify(codes);
    }
    const next: TenantLocalesRow = {
      tenant_id: id,
      default_locale: (patch.default_locale ?? cur.default_locale) || BASE_LOCALE,
      enabled_locales: enabled,
      assistant_localized: patch.assistant_localized !== undefined ? (patch.assistant_localized ? 1 : 0) : cur.assistant_localized,
      updated_at: '',
    };
    await db.upsertTenantLocales(next);
    return next;
  }

  /** The languages a reader may pick in this workspace (built-in + any AI pack), with display names. */
  async function listAvailableLocales(tenantId: string | null): Promise<{ default_locale: string; assistant_localized: boolean; locales: Array<{ code: string; name: string; source: string }> }> {
    const cfg = await getConfig(tenantId);
    const packs = await db.listTenantUiTranslations(tenantId ?? DEFAULT_TENANT);
    const enabled = parseEnabled(cfg.enabled_locales, cfg.default_locale);
    const packByLocale = new Map(packs.map((p) => [p.locale, p]));
    const locales = enabled.map((code) => {
      const builtin = !!BUILTIN_MESSAGES[code];
      const nameFromNotes = TARGET_LANGUAGES.find((l) => l.code === code)?.name;
      const name = code === 'en' ? 'English' : code === 'es' ? 'Español' : nameFromNotes ?? code;
      return { code, name, source: builtin ? 'builtin' : (packByLocale.has(code) ? 'ai' : 'unknown') };
    }).filter((l) => l.source !== 'unknown' || l.code === BASE_LOCALE);
    return { default_locale: cfg.default_locale, assistant_localized: cfg.assistant_localized === 1, locales };
  }

  /**
   * The fully-resolved flat message map for `locale` in `tenantId`. Starts from the English base (so every
   * key is present) and overlays each locale in the fallback chain — built-in first, then the AI pack —
   * from least specific to most specific, so the reader's exact locale wins.
   */
  async function getEffectiveCatalog(locale: string, tenantId: string | null): Promise<{ locale: string; base: string; messages: Catalog }> {
    const chain = resolveLocaleChain(locale || BASE_LOCALE, BASE_LOCALE); // e.g. ['fr','en']
    const packs = await db.listTenantUiTranslations(tenantId ?? DEFAULT_TENANT);
    const packByLocale = new Map(packs.map((p) => [p.locale, p]));
    const messages: Catalog = { ...EN_MESSAGES };
    for (const loc of [...chain].reverse()) { // en → … → fr (most specific last wins)
      const builtin = BUILTIN_MESSAGES[loc];
      if (builtin) for (const k of Object.keys(builtin)) messages[k] = builtin[k]!;
      const pack = packByLocale.get(loc);
      if (pack) {
        let obj: Record<string, unknown> = {};
        try { obj = JSON.parse(pack.messages_json); } catch { /* ignore */ }
        for (const k of Object.keys(EN_MESSAGES)) if (typeof obj[k] === 'string') messages[k] = obj[k] as string;
      }
    }
    return { locale: locale || BASE_LOCALE, base: BASE_LOCALE, messages };
  }

  // ── AI locale packs (translate_ui) ──────────────────────────────────────────────────────

  const KEYS = Object.keys(EN_MESSAGES);
  /** Build the numbered source document the model translates (one `[n] value` line per key). */
  function buildCatalogDoc(): string {
    return KEYS.map((k, i) => `[${i + 1}] ${EN_MESSAGES[k]}`).join('\n');
  }
  /** Parse the translated document back into a { key: value } map, realigned by each line's [n] marker. */
  function parseCatalogDoc(text: string): Catalog {
    const out: Catalog = {};
    for (const line of text.split('\n')) {
      const m = /^\s*\[(\d+)\]\s?(.*)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      const key = KEYS[idx];
      const val = (m[2] ?? '').trim();
      if (key && val) out[key] = val;
    }
    return out;
  }

  /**
   * Translate the whole UI catalog into `targetLanguage` and save it as this workspace's locale pack.
   * Reuses the notes translation engine end-to-end (protect → spotlight → verify). Returns a summary.
   */
  async function translateUi(input: { tenantId: string | null; targetLanguage: string; generate: NoteAiGenerate; userId?: string }): Promise<{ ok: boolean; error?: string; locale?: string; language?: string; translated?: number; total?: number; warnings?: string[] }> {
    const lang = resolveLanguage(input.targetLanguage);
    if (!lang) return { ok: false, error: `unsupported language "${input.targetLanguage}". Try e.g. ${TARGET_LANGUAGES.slice(0, 10).map((l) => l.name).join(', ')}…` };
    if (lang.code === BASE_LOCALE) return { ok: false, error: 'The base language is already English — nothing to translate.' };

    const doc = buildCatalogDoc();
    const { masked, tokens } = protectNonTranslatable(doc);
    const prompt = buildTranslatePrompt(masked, { targetLanguage: lang.name });
    const reply = await input.generate({ system: prompt.system, user: prompt.user, userId: input.userId ?? 'system', tenantId: input.tenantId ?? null, temperature: 0, maxTokens: 2000 });

    const translatedMasked = parseTranslation(reply);
    const verdict = verifyTranslation(masked, translatedMasked, { sameLanguageAllowed: false });
    // A hard failure means we can't trust the alignment; refuse rather than store garbage.
    if (!verdict.ok) return { ok: false, error: `translation check failed: ${verdict.reason ?? 'unknown'}`, language: lang.name };
    const restored = restoreProtected(translatedMasked, tokens);
    const map = parseCatalogDoc(restored);
    const translated = Object.keys(map).length;
    if (translated === 0) return { ok: false, error: 'the model returned no usable translations', language: lang.name };

    const row: TenantUiTranslationRow = {
      tenant_id: input.tenantId ?? DEFAULT_TENANT, locale: lang.code,
      messages_json: JSON.stringify(map), source: 'ai', key_count: translated, updated_at: '',
    };
    await db.upsertTenantUiTranslation(row);

    // Make the new language pickable in Account → Language.
    const cfg = await getConfig(input.tenantId);
    const enabled = parseEnabled(cfg.enabled_locales, cfg.default_locale);
    if (!enabled.includes(lang.code)) await updateConfig(input.tenantId, { enabled_locales: JSON.stringify([...enabled, lang.code]) });

    const warnings = [...verdict.warnings];
    if (translated < KEYS.length) warnings.push(`${KEYS.length - translated} of ${KEYS.length} labels kept their English text (the rest were translated).`);
    void now; // reserved for future audit timestamps
    return { ok: true, locale: lang.code, language: lang.name, translated, total: KEYS.length, warnings };
  }

  /**
   * The system-prompt fragment that asks the assistant to REPLY in the reader's interface language — only
   * when the workspace enabled it (assistant_localized) AND the reader picked a non-English language. Returns
   * '' otherwise (a chat skill already matches the language the user writes in; this forces the workspace one).
   */
  async function assistantLocaleInstruction(tenantId: string | null, userLanguage: string | null | undefined): Promise<string> {
    const cfg = await getConfig(tenantId);
    if (cfg.assistant_localized !== 1) return '';
    const code = (userLanguage || cfg.default_locale || BASE_LOCALE).trim();
    const base = resolveLocaleChain(code, BASE_LOCALE)[0] ?? BASE_LOCALE;
    if (base === BASE_LOCALE) return '';
    const name = base === 'es' ? 'Spanish' : (TARGET_LANGUAGES.find((l) => l.code === base)?.name ?? code);
    return `[Interface language]\nThis person's preferred language is ${name}. Reply in ${name} by default, using natural, fluent ${name}. If they clearly write to you in a different language, match that language instead. Keep code, commands, URLs and product names unchanged.`;
  }

  return { getConfig, updateConfig, listAvailableLocales, getEffectiveCatalog, translateUi, assistantLocaleInstruction };
}

export type I18nService = ReturnType<typeof createI18nService>;

/** The translate_ui tool entry point (agent-callable). */
export function createTranslateUiTool(db: DatabaseAdapter, generate: NoteAiGenerate) {
  const svc = createI18nService(db);
  return {
    async translateUi(args: { targetLanguage: string; tenantId?: string | null; userId?: string }) {
      return svc.translateUi({ targetLanguage: args.targetLanguage, tenantId: args.tenantId ?? null, generate, ...(args.userId ? { userId: args.userId } : {}) });
    },
  };
}
