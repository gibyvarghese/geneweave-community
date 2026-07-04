/**
 * Playwright E2E — Internationalisation (m145, Round 9). Proves the acceptance bar:
 *   • API: GET /api/me/i18n serves the effective UI message pack — English by default; ?locale=es returns the
 *     built-in Spanish (nav.home → "Inicio"); an unknown locale falls back to English (negative).
 *   • Config: an admin sets the workspace default language + turns on assistant localisation via
 *     /api/admin/i18n; GET reflects it (the Builder "Languages" tab contract).
 *   • Real-LLM AI locale pack: through chat, the weave_translator agent's translate_ui tool localises the whole
 *     UI into French (reusing the notes faithful-translation engine); GET /api/me/i18n?locale=fr then returns
 *     French labels + "fr" becomes pickable. (Skipped when no real provider is configured.)
 *   • Assistant localisation (real-LLM, soft): with assistant_localized on + the reader's language Spanish, an
 *     English question gets a non-empty answer (the locale instruction is injected into the system prompt).
 *   • UI: a member whose interface language is Spanish sees the nav relabelled ("Inicio"/"Notas"); screenshot
 *     reviewed against the design language.
 * Run: npm run test:e2e -- i18n   (API/UI tests need no LLM; the AI-pack test uses the default model).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'i18n-owner@weaveintel.dev';

const REAL_LLM = (process.env['DEFAULT_PROVIDER'] ?? (process.env['OPENAI_API_KEY'] ? 'openai' : process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'mock')) !== 'mock';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> {
  return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';
}

// ── API + config: effective catalog, built-in Spanish, unknown-locale fallback, admin policy ──
test('i18n — effective catalog, built-in Spanish, fallback, admin policy', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // POSITIVE — default is English; the catalog carries every key + the list of pickable languages.
  const en = await (await page.request.get(`${origin}/api/me/i18n`)).json() as { locale: string; messages: Record<string, string>; available: { locales: Array<{ code: string }> } };
  expect(en.messages['nav.home']).toBe('Home');
  expect(en.messages['action.newChat']).toBe('New Chat');
  expect(en.available.locales.map((l) => l.code)).toEqual(expect.arrayContaining(['en', 'es']));

  // POSITIVE — the built-in Spanish pack (no AI needed).
  const es = await (await page.request.get(`${origin}/api/me/i18n?locale=es`)).json() as { messages: Record<string, string> };
  expect(es.messages['nav.home']).toBe('Inicio');
  expect(es.messages['nav.notes']).toBe('Notas');
  expect(es.messages['action.newChat']).toBe('Nuevo chat');

  // NEGATIVE — an unknown/garbage locale falls back to English (never blanks).
  const zz = await (await page.request.get(`${origin}/api/me/i18n?locale=zz-XX`)).json() as { messages: Record<string, string> };
  expect(zz.messages['nav.home']).toBe('Home');

  // NEGATIVE — a region variant of Spanish still resolves to Spanish (BCP-47 fallback es-MX → es).
  const esMx = await (await page.request.get(`${origin}/api/me/i18n?locale=es-MX`)).json() as { messages: Record<string, string> };
  expect(esMx.messages['nav.home']).toBe('Inicio');

  // Admin policy (Builder "Languages" tab contract): set default + enabled + assistant localisation.
  const put = await page.request.put(`${origin}/api/admin/i18n/default`, { headers: hdr, data: { default_locale: 'es', enabled_locales: ['en', 'es'], assistant_localized: true } });
  expect(put.status()).toBe(200);
  const cfg = await (await page.request.get(`${origin}/api/admin/i18n/default`)).json() as { tenants: { default_locale: string; assistant_localized: number } };
  expect(cfg.tenants.default_locale).toBe('es');
  expect(cfg.tenants.assistant_localized).toBe(1);

  const list = await (await page.request.get(`${origin}/api/admin/i18n`)).json() as { tenants: Array<{ tenant_id: string }> };
  expect(list.tenants.some((t) => t.tenant_id === 'default')).toBeTruthy();
});

// ── Real-LLM: the translate_ui tool localises the whole UI into French (an AI locale pack) ──
test('i18n — AI locale pack via translate_ui (real LLM)', async ({ page }) => {
  test.skip(!REAL_LLM, 'needs a real LLM provider (set OPENAI_API_KEY / ANTHROPIC_API_KEY)');
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Give the assistant the localisation tool in agent mode.
  const created = await (await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Localise the app' } })).json() as { chat: { id: string } };
  const chatId = created.chat.id;
  await page.request.post(`${origin}/api/chats/${chatId}/settings`, { headers: hdr, data: { mode: 'agent', enabledTools: ['translate_ui'] } });

  // Ask it to translate the interface. Consume the stream to completion.
  const stream = await page.request.post(`${origin}/api/chats/${chatId}/messages/stream`, { headers: hdr, data: { content: 'Please translate the whole app interface into French for our workspace, using your translation tool.' } });
  await stream.body();

  // The French pack should now exist + be pickable, with labels actually translated (not English).
  const fr = await (await page.request.get(`${origin}/api/me/i18n?locale=fr`)).json() as { messages: Record<string, string>; available: { locales: Array<{ code: string }> } };
  expect(fr.available.locales.map((l) => l.code)).toContain('fr');
  // At least one representative label differs from English (the model translated it).
  const changed = ['nav.notes', 'action.newChat', 'action.save', 'nav.home'].some((k) => fr.messages[k] && fr.messages[k] !== ({ 'nav.notes': 'Notes', 'action.newChat': 'New Chat', 'action.save': 'Save', 'nav.home': 'Home' } as Record<string, string>)[k]);
  expect(changed, 'the French pack should differ from English on at least one label').toBeTruthy();

  // Admin can see the pack listed.
  const packs = await (await page.request.get(`${origin}/api/admin/i18n/default`)).json() as { packs: Array<{ locale: string; source: string }> };
  expect(packs.packs.some((p) => p.locale === 'fr' && p.source === 'ai')).toBeTruthy();
});

// ── Real-LLM (soft): assistant replies when localisation is on ──
test('i18n — assistant localisation is wired (real LLM)', async ({ page }) => {
  test.skip(!REAL_LLM, 'needs a real LLM provider');
  test.setTimeout(120_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Reader prefers Spanish; workspace forces assistant localisation.
  await page.request.put(`${origin}/api/me/account/profile`, { headers: hdr, data: { language: 'es' } });
  await page.request.put(`${origin}/api/admin/i18n/default`, { headers: hdr, data: { assistant_localized: true } });

  const created = await (await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Localised reply' } })).json() as { chat: { id: string } };
  const stream = await page.request.post(`${origin}/api/chats/${created.chat.id}/messages/stream`, { headers: hdr, data: { content: 'In one short sentence, tell me what you can help with.' } });
  await stream.body();
  const msgs = await (await page.request.get(`${origin}/api/chats/${created.chat.id}/messages`)).json() as { messages: Array<{ role: string; content: string }> };
  const reply = [...msgs.messages].reverse().find((m) => m.role === 'assistant');
  expect(reply?.content && reply.content.trim().length > 0, 'the assistant should answer').toBeTruthy();
});

// ── UI: a Spanish-preference reader sees the nav relabelled + screenshot ──
test('i18n — UI nav is shown in the reader’s language', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Set this reader's interface language to Spanish, then reload so the app boots with the Spanish pack.
  await page.request.put(`${origin}/api/me/account/profile`, { headers: hdr, data: { language: 'es' } });
  await page.reload();
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });

  const nav = page.locator('.workspace-menu');
  await expect(nav.getByText('Inicio', { exact: true })).toBeVisible();
  await expect(nav.getByText('Notas', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/i18n-nav-spanish.png', fullPage: false });

  // Switch back to English via the live path (Account → Language) and confirm it relabels without a reload.
  await page.request.put(`${origin}/api/me/account/profile`, { headers: hdr, data: { language: 'en-US' } });
  await page.evaluate(async () => {
    const win = window as unknown as { loadI18n?: (l: string) => Promise<void>; render?: () => void };
    if (win.loadI18n) await win.loadI18n('en-US');
    if (win.render) win.render();
  });
  await expect(page.locator('.workspace-menu').getByText('Home', { exact: true })).toBeVisible({ timeout: 8000 });
});
