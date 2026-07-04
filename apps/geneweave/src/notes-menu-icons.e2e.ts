/**
 * Playwright E2E — Notes Insert + overflow (⋯) menus use the branded line-icon set (not emoji).
 * Opens each menu, asserts every item's icon is an inline SVG (the app's icon language, matching the left
 * nav), and screenshots both for a visual branding review.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'menuicons-owner@weaveintel.dev';

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

test('Notes — Insert + ⋯ menus render branded SVG icons', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  await page.getByText('New note', { exact: true }).first().click();
  await expect(page.locator('.notes-ai-insert')).toBeVisible({ timeout: 15000 });

  // Insert popover (the "+ Insert" emerald button).
  await page.locator('.gw-btn-emerald', { hasText: 'Insert' }).first().click();
  const insertMenu = page.locator('.gw-menu-rich:visible').first();
  await expect(insertMenu).toBeVisible({ timeout: 5000 });
  // Every card + list icon is an inline SVG (branded), none are emoji text.
  const cardIcons = insertMenu.locator('.gw-menu-card-ic');
  await expect(cardIcons.first()).toBeVisible();
  expect(await cardIcons.count()).toBeGreaterThan(0);
  expect(await insertMenu.locator('.gw-menu-card-ic svg').count()).toBe(await cardIcons.count());
  const itemIcons = insertMenu.locator('.gw-menu-item-ic');
  expect(await itemIcons.count()).toBeGreaterThan(0);
  expect(await insertMenu.locator('.gw-menu-item-ic svg').count()).toBe(await itemIcons.count());
  await page.screenshot({ path: 'test-results/menu-icons-insert.png', fullPage: false });

  // Close, then open the overflow (⋯) menu.
  await page.keyboard.press('Escape');
  await page.locator('.gw-icon-btn[title="More actions"]').first().click();
  const overflowMenu = page.locator('.gw-menu-rich:visible').first();
  await expect(overflowMenu).toBeVisible({ timeout: 5000 });
  const ovItems = overflowMenu.locator('.gw-menu-item-ic');
  expect(await ovItems.count()).toBeGreaterThan(0);
  expect(await overflowMenu.locator('.gw-menu-item-ic svg').count()).toBe(await ovItems.count());
  await page.screenshot({ path: 'test-results/menu-icons-overflow.png', fullPage: false });
});
