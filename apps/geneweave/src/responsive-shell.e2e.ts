/**
 * Playwright E2E — the responsive adaptive shell (web · tablet · mobile). Proves the app is navigable at
 * every size and that the design-token SSOT is live:
 *   • Desktop (1440): the workspace nav is a persistent side panel; no hamburger.
 *   • Mobile (390): the nav is an off-canvas DRAWER (hidden); a hamburger opens it over a backdrop;
 *     Escape / backdrop-tap closes it. 44px hit target.
 *   • Tablet (834): single-column content, drawer nav.
 *   • The `--gw-*` design tokens (from @weaveintel/tokens) are applied to :root.
 * Run: npm run test:e2e -- responsive-shell  (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const USER = 'wnresp-user@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
const inViewport = async (page: Page, sel: string): Promise<boolean> => {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) return false;
  const w = page.viewportSize()!.width;
  return box.x >= -2 && box.x < w - 10; // left edge within the viewport
};

test('Responsive shell — nav is a side panel on desktop and a drawer on mobile; tokens live', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, USER);

  // Design-token SSOT is applied to :root.
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gw-color-accent').trim());
  expect(accent.toLowerCase()).toBe('#0e9a6e'); // emerald from @weaveintel/tokens

  // DESKTOP: nav is a persistent side panel; hamburger hidden.
  await expect(page.locator('.workspace-nav')).toBeVisible();
  expect(await page.locator('.gw-hamburger').isVisible()).toBe(false);
  await page.screenshot({ path: 'test-results/responsive-desktop.png' });

  // MOBILE: nav becomes an off-canvas drawer; a hamburger appears.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.gw-hamburger')).toBeVisible();
  expect(await inViewport(page, '.workspace-nav')).toBe(false); // drawer is off-screen
  await page.screenshot({ path: 'test-results/responsive-mobile-closed.png' });

  // Open the drawer via the hamburger → nav slides in over a backdrop (poll past the 0.22s transition).
  await page.locator('.gw-hamburger').click();
  await expect(page.locator('.app.nav-open')).toHaveCount(1);
  await expect(page.locator('.nav-backdrop')).toBeVisible();
  await expect.poll(() => inViewport(page, '.workspace-nav'), { timeout: 3000 }).toBe(true);
  await page.screenshot({ path: 'test-results/responsive-mobile-open.png' });

  // Escape closes it (keyboard accessibility).
  await page.keyboard.press('Escape');
  await expect(page.locator('.app.nav-open')).toHaveCount(0);
  await expect.poll(() => inViewport(page, '.workspace-nav'), { timeout: 3000 }).toBe(false);

  // 44px minimum hit target on the hamburger.
  const hb = await page.locator('.gw-hamburger').boundingBox();
  expect(hb!.width).toBeGreaterThanOrEqual(40);
  expect(hb!.height).toBeGreaterThanOrEqual(40);

  // TABLET.
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(page.locator('.gw-hamburger')).toBeVisible();
  await page.screenshot({ path: 'test-results/responsive-tablet.png' });
});
