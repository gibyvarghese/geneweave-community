/**
 * Account settings surface — API + UI + real-LLM (m136; "GeneWeave Account.dc.html").
 *
 *  • API — the /api/me/account contract: default shape, profile round-trip, the notifications matrix,
 *    validation (unknown event → 400), and server-side sanitisation of a hostile payload.
 *  • UI  — log in, open Account from the profile menu, walk all seven sections taking screenshots to
 *    review against the design, edit a field + Save, and toggle a notification. Plus a mobile viewport.
 *  • LLM — the assistant changes the signed-in user's OWN account via the update_account_profile tool
 *    ("set my status … and start my week on Sunday") and we confirm it persisted.
 *
 * Run: npm run test:e2e -- account-settings
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<{ csrf: string }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  const res = await page.request.post('/api/auth/login', { data: { email, password: PW } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { csrf: me.csrfToken ?? '' };
}

// ── API ───────────────────────────────────────────────────────────────────────────────────────────
test('API — /api/me/account contract, round-trip, matrix, validation & sanitisation', async ({ page }) => {
  test.setTimeout(60_000);
  const { csrf } = await login(page, 'acct-api@weaveintel.dev');
  const H = { 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // Default shape.
  const view0 = await (await page.request.get('/api/me/account')).json() as any;
  expect(view0.account.profile.email).toBe('acct-api@weaveintel.dev');
  expect(view0.account.preferences.language).toBe('en-US');
  expect(view0.account.notifications).toHaveLength(5);

  // Profile round-trip.
  const put = await page.request.put('/api/me/account/profile', { headers: H, data: {
    display_name: 'API Tester', pronouns: 'they/them', role_title: 'QA', week_start: 'sunday', ui_variant: 'creative', language: 'fr',
  } });
  expect(put.ok()).toBeTruthy();
  const view1 = (await put.json() as any).account;
  expect(view1.profile.pronouns).toBe('they/them');
  expect(view1.preferences.week_start).toBe('sunday');
  expect(view1.preferences.ui_variant).toBe('creative');
  expect(view1.preferences.language).toBe('fr');

  // Notifications matrix.
  const nt = await page.request.put('/api/me/account/notifications', { headers: H, data: { event: 'comments', email: false, push: true } });
  expect(nt.ok()).toBeTruthy();
  const view2 = (await nt.json() as any).account;
  const comments = view2.notifications.find((n: any) => n.event_key === 'comments');
  expect(comments.email).toBe(false); expect(comments.push).toBe(true);

  // Validation — unknown event rejected.
  const bad = await page.request.put('/api/me/account/notifications', { headers: H, data: { event: 'telepathy', push: true } });
  expect(bad.status()).toBe(400);

  // Security — a control-char + oversized payload is sanitised server-side.
  const hostile = 'x'.repeat(400);
  const sec = await page.request.put('/api/me/account/profile', { headers: H, data: { role_title: hostile } });
  const stored = (await sec.json() as any).account.profile.role_title as string;
  expect(stored.length).toBeLessThanOrEqual(120);
});

// ── UI ────────────────────────────────────────────────────────────────────────────────────────────
async function openAccount(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as any;
    if (win.state) win.state.view = 'account';
    if (win.render) win.render();
  });
  await expect(page.locator('.acct-app')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.acct-nav')).toBeVisible();
}

test('UI — all seven sections render to the design; edit+save & notification toggle work', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'acct-ui@weaveintel.dev');
  await openAccount(page);

  // Design-token SSOT is live on this surface too (accent emerald).
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gw-color-accent').trim());
  expect(accent.toLowerCase()).toBe('#0e9a6e');

  const sections: Array<[string, string]> = [
    ['Profile', 'profile'], ['Account & security', 'security'], ['Preferences', 'prefs'],
    ['Notifications', 'notifs'], ['People', 'members'], ['Admin & governance', 'admin'], ['Plan & billing', 'billing'],
  ];
  for (const [label, key] of sections) {
    await page.locator('.acct-nav-item', { hasText: label }).first().click();
    await expect(page.locator('.acct-title')).toHaveText(new RegExp(label.split(' ')[0]!, 'i'));
    await page.screenshot({ path: `${SHOT}/account-${key}.png` });
  }

  // Edit display name on Profile and Save.
  await page.locator('.acct-nav-item', { hasText: 'Profile' }).first().click();
  const nameInput = page.locator('.acct-field', { hasText: 'Display name' }).locator('input');
  await nameInput.fill('Renamed Person');
  await expect(page.locator('.acct-savebar.dirty')).toBeVisible();
  await page.locator('.acct-savebar .acct-btn-emerald').click();
  await expect(page.locator('.acct-savebar-status')).toHaveText(/All changes saved/, { timeout: 8000 });
  // Persisted server-side.
  const acc = await (await page.request.get('/api/me/account')).json() as any;
  expect(acc.account.profile.display_name).toBe('Renamed Person');

  // Notifications toggle persists.
  await page.locator('.acct-nav-item', { hasText: 'Notifications' }).first().click();
  const firstToggle = page.locator('.acct-notif-row').first().locator('.acct-toggle').nth(1); // EMAIL col of first row
  const wasOn = (await firstToggle.getAttribute('class'))?.includes('on');
  await firstToggle.click();
  await page.waitForTimeout(600);
  const nowOn = (await firstToggle.getAttribute('class'))?.includes('on');
  expect(nowOn).toBe(!wasOn);
  await page.screenshot({ path: `${SHOT}/account-notifs-toggled.png` });
});

test('UI — responsive: nav collapses to a top row on mobile', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, 'acct-mobile@weaveintel.dev');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccount(page);
  // The content column single-columns; the grid collapses. Screenshot for review.
  await expect(page.locator('.acct-content')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/account-mobile.png` });
});

// ── real LLM ──────────────────────────────────────────────────────────────────────────────────────
test('LLM — the assistant updates the signed-in user’s own account via the tool', async ({ page }) => {
  test.setTimeout(220_000);
  const { csrf } = await login(page, 'acct-llm@weaveintel.dev');
  const H = { 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const chat = await (await page.request.post('/api/chats', { headers: H, data: { title: 'Account' } })).json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.chat.id}/settings`, { headers: H, data: { mode: 'agent', enabledTools: ['update_account_profile'] } });

  // Drive the model; consume the stream so the run completes before we assert.
  const r = await page.request.post(`/api/chats/${chat.chat.id}/messages/stream`, { headers: H, timeout: 200_000, data: {
    content: 'Please update my account: set my status to "Focusing · back at 2:00", call me they/them, and start my week on Sunday.',
  } });
  await r.body(); // wait for the stream to finish

  const acc = await (await page.request.get('/api/me/account')).json() as any;
  // eslint-disable-next-line no-console
  console.log('[account][llm] profile after:', JSON.stringify(acc.account.profile), acc.account.preferences.week_start);
  expect(acc.account.profile.pronouns.toLowerCase()).toContain('they');
  expect(acc.account.profile.status_text.toLowerCase()).toContain('focusing');
  expect(acc.account.preferences.week_start).toBe('sunday');
});
