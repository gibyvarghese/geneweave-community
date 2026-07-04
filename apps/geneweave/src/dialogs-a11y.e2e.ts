// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — accessible dialogs + recoverable errors (m142 / Round 5: FP-E, H15).
 *
 * Proves the acceptance bar (no LLM needed — UI behaviour):
 *   • Accessible confirm: deleting a chat opens a WAI-ARIA alertdialog (role + aria-modal + labelled/described),
 *     focus moves to the SAFE (Cancel) button, Esc cancels (nothing deleted), and confirming deletes.
 *   • Focus trap + return-focus: Tab stays inside the dialog; on close, focus returns to the trigger.
 *   • Config + admin: the per-tenant "confirm destructive actions" policy round-trips (admin off → deletes
 *     skip the dialog).
 *   • H15 — a failed data load shows a recoverable banner with Retry, instead of failing silently.
 * Run: npm run test:e2e -- dialogs-a11y   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'da-owner@weaveintel.dev';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'da', email: OWNER, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: OWNER, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}
const chatCount = async (page: Page, origin: string): Promise<number> =>
  ((await (await page.request.get(`${origin}/api/chats`)).json()) as { chats: unknown[] }).chats.length;

// ── Config + admin round-trip (deterministic) ─────────────────────────────────────────
test('Dialogs — confirm-destructive policy round-trips', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  const def = await (await page.request.get(`${origin}/api/me/accessibility`)).json() as { confirmDestructive: boolean };
  expect(def.confirmDestructive).toBe(true);

  const put = await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { confirm_destructive: 0 } });
  expect(put.status()).toBe(200);
  const got = await (await page.request.get(`${origin}/api/admin/accessibility/default`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['confirm_destructive']).toBe(0);
  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { confirm_destructive: 1 } });
});

// ── Accessible confirm dialog: attributes, safe focus, Esc cancels, confirm deletes ────
test('Dialogs — deleting a chat uses an accessible alertdialog (Esc cancels, confirm deletes, focus returns)', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Delete me A' } });
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Delete me B' } });
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const before = await chatCount(page, origin);
  expect(before).toBeGreaterThanOrEqual(2);

  const del = page.locator('.chat-item .del').first();
  await del.click({ force: true });

  // The accessible dialog is a proper alertdialog.
  const dialog = page.locator('.gw-dialog[role="alertdialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAttribute('aria-labelledby', /gw-dialog-title/);
  await expect(dialog).toHaveAttribute('aria-describedby', /gw-dialog-desc/);
  // Focus landed on a button INSIDE the dialog (the safe Cancel, for a destructive action).
  expect(await page.evaluate(() => document.activeElement?.closest('.gw-dialog') !== null)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel');
  await page.screenshot({ path: '/tmp/pw-da-confirm.png' });

  // Focus trap: Tab keeps focus inside the dialog.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('.gw-dialog') !== null)).toBe(true);

  // Esc cancels — dialog closes, NOTHING deleted, focus returns to the trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await chatCount(page, origin)).toBe(before);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('del'))).toBe(true);

  // Now really delete: open again + click the danger confirm.
  await del.click({ force: true });
  await expect(page.locator('.gw-dialog[role="alertdialog"]')).toBeVisible();
  await page.locator('.gw-dialog-btn.danger').click();
  await expect(page.locator('.gw-dialog')).toHaveCount(0);
  await expect.poll(async () => chatCount(page, origin), { timeout: 8000 }).toBe(before - 1);
});

// ── Policy OFF → destructive action skips the dialog (power-user mode) ─────────────────
test('Dialogs — with confirm-destructive OFF, a delete skips the dialog', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Quick delete' } });
  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { confirm_destructive: 0 } });
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const before = await chatCount(page, origin);

  await page.locator('.chat-item .del').first().click({ force: true });
  // No dialog — the delete happens straight away.
  await expect(page.locator('.gw-dialog')).toHaveCount(0);
  await expect.poll(async () => chatCount(page, origin), { timeout: 8000 }).toBe(before - 1);

  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { confirm_destructive: 1 } });
});

// ── H15 — a failed data load surfaces a recoverable banner (not silent) ────────────────
test('Dialogs — a failed data load shows a Retry banner, and Retry recovers', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);

  // Make the chats endpoint fail, then reload so init's loadChats() hits it.
  await page.route('**/api/chats', (route) => route.abort());
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });

  const banner = page.locator('.load-error');
  await expect(banner).toBeVisible({ timeout: 8000 });
  await expect(banner.locator('.load-error-text')).toContainText(/chats/i);
  await expect(banner.locator('.load-error-retry')).toBeVisible();
  await page.screenshot({ path: '/tmp/pw-da-load-error.png' });

  // Recover: stop failing, click Retry → the banner clears.
  await page.unroute('**/api/chats');
  await banner.locator('.load-error-retry').click();
  await expect(page.locator('.load-error')).toHaveCount(0, { timeout: 8000 });
});
