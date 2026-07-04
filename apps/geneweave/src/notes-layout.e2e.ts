/**
 * Playwright E2E — Notes editor layout: wider reading column + collapsible notebooks rail.
 *
 *  • The note's content column now uses more of the screen (a wider "measure") instead of a narrow 720px.
 *  • The notebooks rail can be COLLAPSED (« hides it → the note gets the full canvas) and re-opened (»),
 *    matching the app's sidebar-collapse pattern.
 * Run: npm run test:e2e -- notes-layout   (no LLM needed).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'layout-owner@weaveintel.dev';

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

test('notes layout — wider content column + collapsible rail', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, OWNER);
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  await page.getByText('New note', { exact: true }).first().click();
  await expect(page.locator('.gw-page')).toBeVisible({ timeout: 15000 });

  // The reading column is wider than the old 720px measure.
  const pageWidth = await page.locator('.gw-page').evaluate((el) => el.getBoundingClientRect().width);
  expect(pageWidth, `content column should be wider than 720px (got ${pageWidth})`).toBeGreaterThan(820);
  await page.screenshot({ path: 'test-results/notes-layout-wide.png', fullPage: false });

  // Collapse the notebooks rail.
  await expect(page.locator('.gw-leftrail')).toBeVisible();
  await page.locator('.gw-rail-collapse').click();
  await expect(page.locator('.gw-leftrail')).toHaveCount(0);
  await expect(page.locator('.gw-shell-2col.rail-collapsed')).toBeVisible();
  const expandBtn = page.locator('.gw-rail-expand');
  await expect(expandBtn).toBeVisible();
  await page.screenshot({ path: 'test-results/notes-layout-collapsed.png', fullPage: false });

  // Re-open it.
  await expandBtn.click();
  await expect(page.locator('.gw-leftrail')).toBeVisible();
  await expect(page.locator('.gw-rail-expand')).toHaveCount(0);
});
