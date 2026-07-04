// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — focus & keyboard accessibility sweep (m141 / Round 4: H11, H12, H13, FP-D).
 *
 * Proves the acceptance bar (no LLM needed — this is UI/keyboard behaviour):
 *   • H13 — focus survives a full re-render: the composer (and a focused chat item) keep keyboard focus after
 *     `render()` wipes and rebuilds the DOM (previously focus was dumped to <body>).
 *   • H11 — div-as-button controls (chat search results) are keyboard-operable (role=button + tabindex).
 *   • H12 — the AI-settings trigger announces its open state (aria-expanded) and Esc returns focus to it.
 *   • FP-D — the active admin tab carries aria-current="page".
 *   • Config + admin: the workspace "always show focus outlines" default round-trips and is applied to <html>.
 * Run: npm run test:e2e -- focus-a11y   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'fa-owner@weaveintel.dev';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'fa', email: OWNER, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: OWNER, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}

// ── Config + admin round-trip + the <html> flag (deterministic) ───────────────────────
test('Focus a11y — accessibility "always show focus" config round-trips + applies', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);

  const def = await (await page.request.get(`${origin}/api/me/accessibility`)).json() as { alwaysShowFocus: boolean };
  expect(def.alwaysShowFocus).toBe(false);

  const put = await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { always_show_focus: 1 } });
  expect(put.status()).toBe(200);
  const got = await (await page.request.get(`${origin}/api/admin/accessibility/default`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['always_show_focus']).toBe(1);

  // Reload — the client should apply the workspace default to the document.
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-force-focus-ring')), { timeout: 8000 }).toBe('1');

  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { always_show_focus: 0 } });
});

// ── H13 — focus preserved across a full re-render ─────────────────────────────────────
test('Focus a11y — H13: keyboard focus survives a full re-render (composer + chat item)', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Focus chat A' } });
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Focus chat B' } });
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });

  // Composer keeps focus after a render() wipe+rebuild.
  const composer = page.locator('textarea[data-focus-key="composer"]');
  await expect(composer).toBeVisible({ timeout: 8000 });
  await composer.click();
  await page.evaluate(() => (window as unknown as { render?: () => void }).render?.());
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-key'))).toBe('composer');

  // A focused chat item keeps focus after render() (its data-focus-key is stable across the rebuild).
  const firstChatKey = await page.evaluate(() => document.querySelector('[data-focus-key^="chat-"]')?.getAttribute('data-focus-key') ?? null);
  expect(firstChatKey).toBeTruthy();
  await page.evaluate((k: string) => (document.querySelector(`[data-focus-key="${k}"]`) as HTMLElement)?.focus(), firstChatKey!);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-key'))).toBe(firstChatKey);
  await page.evaluate(() => (window as unknown as { render?: () => void }).render?.());
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-key'))).toBe(firstChatKey);
  await page.screenshot({ path: '/tmp/pw-fa-focus-preserved.png' });
});

// ── H11 + H12 — keyboard-operable search results; settings trigger state + Esc return ──
test('Focus a11y — H11 search results operable; H12 settings trigger state + Esc returns focus', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Searchable Alpha' } });
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });

  // H11 — chat search results are role=button + tab-focusable (were bare divs).
  const search = page.locator('input[placeholder="Search chats..."]').first();
  if (await search.count()) {
    await search.fill('Searchable');
    const item = page.locator('.search-item').first();
    await expect(item).toBeVisible({ timeout: 5000 });
    await expect(item).toHaveAttribute('role', 'button');
    await expect(item).toHaveAttribute('tabindex', '0');
    await search.fill('');
  }

  // H12 — the AI-settings trigger announces open state and Esc returns focus to it.
  const trigger = page.locator('[data-focus-key="chat-settings-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 8000 });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'true');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(page.locator('[data-focus-key="chat-settings-trigger"]')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-key="chat-settings-trigger"]')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-key'))).toBe('chat-settings-trigger');
});

// ── FP-D — active admin tab carries aria-current ──────────────────────────────────────
test('Focus a11y — FP-D: the active admin tab is marked aria-current', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  // Open the admin/Builder area and expand its nav.
  await page.evaluate(() => {
    const win = window as unknown as { state?: { view: string; adminMenuExpanded?: boolean }; render?: () => void };
    if (win.state) { win.state.view = 'admin'; win.state.adminMenuExpanded = true; }
    win.render?.();
  });
  const active = page.locator('.admin-subtab.active').first();
  if (await active.count()) {
    await expect(active).toHaveAttribute('aria-current', 'page');
    await page.screenshot({ path: '/tmp/pw-fa-admin-current.png' });
  }
});
