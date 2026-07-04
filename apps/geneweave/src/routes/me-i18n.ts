/**
 * /api/me/i18n — the interface language pack for the signed-in reader (m145).
 *
 *   GET /api/me/i18n?locale=xx   the effective UI messages for `locale` in the caller's workspace
 *
 * The web UI is served as raw modules and can't bundle the catalog, so it fetches its labels here. The
 * response merges the English base + any built-in locale (Spanish) + the workspace's AI-generated locale
 * pack, resolved down the BCP-47 fallback chain, plus the list of languages the reader may pick. If no
 * `locale` is given we fall back to the workspace default.
 */
import type { DatabaseAdapter } from '../db.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createI18nService } from '../i18n-sql.js';

export function registerMeI18nRoutes(router: Router, db: DatabaseAdapter): void {
  const svc = createI18nService(db);

  router.get('/api/me/i18n', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cfg = await svc.getConfig(auth.tenantId ?? null);
    // No explicit ?locale → the reader's saved interface language (user_preferences.language), else the
    // workspace default. This lets the UI just call GET /api/me/i18n and get the right pack.
    let saved: string | null = null;
    try { saved = ((await db.getUserPreferences(auth.userId)) as { language?: string } | null)?.language ?? null; } catch { /* ignore */ }
    const locale = (url.searchParams.get('locale') || saved || cfg.default_locale || 'en').trim();
    const [cat, available] = await Promise.all([
      svc.getEffectiveCatalog(locale, auth.tenantId ?? null),
      svc.listAvailableLocales(auth.tenantId ?? null),
    ]);
    json(res, 200, { locale: cat.locale, base: cat.base, messages: cat.messages, available });
  });
}
