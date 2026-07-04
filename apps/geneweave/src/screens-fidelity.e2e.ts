/**
 * Visual-fidelity capture for the Builder + Notes screens (review vs the dc.html designs).
 * Not an assertion test — it drives each screen at desktop + mobile and saves screenshots.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await page.waitForSelector('.workspace-nav', { timeout: 15000 });
}

async function go(page: Page, view: string): Promise<void> {
  await page.evaluate((v) => { const w = window as any; if (w.state) w.state.view = v; if (w.loadAdmin && v === 'builder') w.loadAdmin(); if (w.render) w.render(); }, view);
  await page.waitForTimeout(1500);
}

test('capture Builder', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'shot-builder@weaveintel.dev');
  await go(page, 'builder');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/builder-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT}/builder-mobile.png` });
});

test('capture Notes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'shot-notes@weaveintel.dev');
  await go(page, 'notes');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOT}/notes-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  // Mobile: the notebooks rail is a drawer — hidden until the topbar toggle opens it.
  const railBox0 = await page.locator('.gw-leftrail').boundingBox();
  await page.screenshot({ path: `${SHOT}/notes-mobile.png` });
  await page.locator('.gw-rail-toggle').click();
  await page.waitForTimeout(500);
  const railBox1 = await page.locator('.gw-leftrail').boundingBox();
  await page.screenshot({ path: `${SHOT}/notes-mobile-drawer.png` });
  // The rail was off-screen (x<0) and slides in (x≈0).
  expect(railBox0!.x).toBeLessThan(0);
  expect(railBox1!.x).toBeGreaterThan(-2);
});
