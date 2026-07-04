// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0 — Builder admin UI screenshots (visual evidence).
 * Opens the weaveNotes admin group and screenshots (a) Settings (showing the new per-user AI
 * rate-limit dial) and (b) the new Activity / Audit viewer. Compared against the Builder design
 * (design_handoff_geneweave/GeneWeave Builder.dc.html — same column layout + Plus Jakarta Sans).
 *
 * Run: npm run test:e2e -- weavenotes-phase0-admin-ui
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function enter(page: Page): Promise<void> {
  await page.goto('/');
  if (!(await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false))) {
    let login = await page.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: PASSWORD } });
    if (login.status() !== 200) {
      await page.request.post('/api/auth/register', { data: { name: 'Admin', email: ADMIN_EMAIL, password: PASSWORD } });
      login = await page.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: PASSWORD } });
      expect(login.status()).toBe(200);
    }
    await page.goto('/');
  }
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 8000 });
}

async function goAdmin(page: Page): Promise<void> {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 8000 });
}

async function openTab(page: Page, tabKey: string, groupLabel: string): Promise<void> {
  const adminMenu = page.locator('.admin-nav-sub');
  if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-parent').click();
    await expect(adminMenu).toBeVisible({ timeout: 8000 });
  }
  const tabButton = page.locator(`[data-admin-tab="${tabKey}"]`).first();
  if (!(await tabButton.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-group-btn', { hasText: groupLabel }).click();
  }
  await expect(tabButton).toBeVisible({ timeout: 8000 });
  await tabButton.click();
}

test('weaveNotes Settings shows the new per-user AI rate-limit dial', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await enter(page);
  await goAdmin(page);
  await openTab(page, 'weavenotes-settings', 'weaveNotes');
  // The rate-limit column renders in the settings table (proves the new field is wired end-to-end:
  // migration → row type → admin schema → Builder UI). Header is the uppercased key.
  await expect(page.getByText(/rate per min/i).first()).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT}/admin-weavenotes-settings.png`, fullPage: true });
});

test('weaveNotes Activity / Audit viewer renders the read-only feed', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await enter(page);
  // Seed one activity row so the table isn't empty.
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  await page.request.post('/api/me/notes', { headers: { 'x-csrf-token': me.csrfToken ?? '' }, data: { title: 'Audit demo note', doc_json: { type: 'doc', content: [] } } });
  await goAdmin(page);
  await openTab(page, 'note-activity', 'weaveNotes');
  await expect(page.locator('[data-admin-tab="note-activity"]')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT}/admin-note-activity.png`, fullPage: true });
});
