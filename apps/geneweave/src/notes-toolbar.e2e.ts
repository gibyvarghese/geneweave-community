/**
 * Playwright E2E — Notes rich-text toolbar: highlighter swatches show distinct colours + the pen works.
 *
 *  • Each of the four highlighter swatches renders its OWN colour (amber/pink/teal/blue), not all the same /
 *    transparent. (They now take their colour from a design-token stylesheet class.)
 *  • The text-colour dropdown swatches each render a distinct colour too.
 *  • The pen (ink) tool actually does something: clicking it inserts an editable drawing (ink canvas) into the
 *    note. It used to be inert.
 * Run: npm run test:e2e -- notes-toolbar   (no LLM needed).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'toolbar-owner@weaveintel.dev';

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

test('Notes toolbar — highlighter + text-colour swatches show distinct colours; pen inserts a drawing', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  await page.getByText('New note', { exact: true }).first().click();
  await page.locator('.gw-toolstrip').waitFor({ timeout: 15000 });

  // Highlighter swatches — each has a real, distinct background colour.
  const hlBgs = await page.locator('.gw-hl').evaluateAll((els) =>
    els.map((el) => getComputedStyle(el as Element).backgroundColor));
  expect(hlBgs.length).toBe(4);
  expect(hlBgs.every((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'), `swatch bgs: ${hlBgs.join(', ')}`).toBe(true);
  expect(new Set(hlBgs).size).toBe(4); // all four are DIFFERENT colours

  // Text-colour dropdown — open it and check its swatches are coloured + distinct.
  await page.locator('.gw-tool[title="Text colour"]').click();
  const swBgs = await page.locator('.gw-color-swatch').evaluateAll((els) =>
    els.map((el) => getComputedStyle(el as Element).backgroundColor));
  expect(swBgs.length).toBeGreaterThan(1);
  expect(swBgs.every((c) => c && c !== 'rgba(0, 0, 0, 0)')).toBe(true);
  expect(new Set(swBgs).size).toBeGreaterThan(1);
  await page.screenshot({ path: 'test-results/notes-toolbar-colours.png', fullPage: false });
  await page.keyboard.press('Escape');

  // The pen inserts an editable drawing (ink canvas) into the note.
  await expect(page.locator('.gw-ink-block')).toHaveCount(0);
  await page.locator('.gw-tool[title="Insert a drawing (ink canvas)"]').click();
  await expect(page.locator('.gw-ink-block')).toHaveCount(1, { timeout: 5000 });
  await page.screenshot({ path: 'test-results/notes-toolbar-pen-ink.png', fullPage: false });
});
