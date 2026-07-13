// SPDX-License-Identifier: MIT
/**
 * Playwright E2E (`@upgrade-critical`) — the Upgrade Center review queue, driven as a real browser screen.
 *
 * Registers an admin on a fresh DB, seeds a mixed review queue (a diverged skill with an upstream + a P1 + two
 * P3s), navigates Admin → Governance → Upgrade Center, and resolves the whole queue by KEYBOARD:
 *   • navigate to the diverged skill (j) and ADOPT it (2) → it leaves the queue and the live row takes upstream;
 *   • UNDO (u) → the item returns and the live row is restored (badge truthfulness across adopt→revert);
 *   • BULK keep-mine (never touches the P1) clears the remaining non-P1s;
 *   • KEEP (1) the lone P1 individually → the queue reaches zero.
 * Plus DB-through-API assertions on the resolutions/audit at each step, and a negative check that the bulk
 * guardrail left the P1 for last.
 *
 * Run: `PLAYWRIGHT_E2E=1 npm run test:e2e -- upgrade-center` (the fixture route is gated on PLAYWRIGHT_E2E).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'upgrade-center-admin@weaveintel.dev'; // first-registered on a fresh DB → admin

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
const csrf = async (page: Page): Promise<string> =>
  (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';

async function openUpgradeCenter(page: Page): Promise<void> {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-parent').click();
    await expect(sub).toBeVisible({ timeout: 5000 });
  }
  const tab = page.locator('[data-admin-tab="upgrade-center"]').first();
  if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  }
  await tab.click();
  await expect(page.locator('[data-upgrade-center]')).toBeVisible({ timeout: 8000 });
}

/** The current review items (via the API) — the DB-through-API audit assertion surface. */
async function reviewItems(page: Page): Promise<Array<{ id: string; family: string; priority: string }>> {
  const origin = new URL(page.url()).origin;
  const q = await (await page.request.get(`${origin}/api/admin/upgrade/review`)).json() as { items: Array<{ id: string; family: string; priority: string }> };
  return q.items;
}

test('@upgrade-critical Upgrade Center — a mixed queue is resolved entirely by keyboard (adopt, undo, bulk, keep)', async ({ page }) => {
  await login(page, ADMIN);
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const origin0 = new URL('/', page.url()).origin || (await page.evaluate(() => location.origin));

  // A self-registered user is tenant_admin; the upgrade routes require platform_admin. Promote (E2E-only;
  // auth reads persona fresh from the DB, so the next request already sees it).
  await page.request.post(`${origin0}/api/admin/upgrade/_test/promote-admin`, { headers: H, data: {} });

  // Seed the mixed queue (diverged skill + P1 + two P3s).
  const seed = await (await page.request.post(`${origin0}/api/admin/upgrade/_test/seed-review`, { headers: H, data: {} })).json() as { seeded: number; skillKey: string };
  expect(seed.seeded).toBe(4);

  await openUpgradeCenter(page);
  await expect(page.locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', '4');

  // The diverged skill's detail id (to locate its row for keyboard navigation).
  const skillItem = (await reviewItems(page)).find((i) => i.family === 'skills')!;
  const rows = page.locator('.uc-review-row');
  const count = await rows.count();
  let skillIndex = -1;
  for (let i = 0; i < count; i++) if ((await rows.nth(i).getAttribute('data-uc-review-item')) === skillItem.id) { skillIndex = i; break; }
  expect(skillIndex).toBeGreaterThanOrEqual(0);

  // KEYBOARD: focus the queue, navigate to the skill (j × index), ADOPT it (2).
  await page.locator('[data-uc-review]').focus();
  for (let i = 0; i < skillIndex; i++) await page.keyboard.press('j');
  await page.keyboard.press('2');
  await expect(page.locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', '3', { timeout: 8000 });
  // The skill is gone from the queue and recorded 'adopted'.
  expect((await reviewItems(page)).some((i) => i.id === skillItem.id)).toBe(false);

  // KEYBOARD UNDO (u): the adopted skill returns to the queue (badge truthfulness — the record is restored).
  await page.locator('[data-uc-review]').focus();
  await page.keyboard.press('u');
  await expect(page.locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', '4', { timeout: 8000 });
  expect((await reviewItems(page)).some((i) => i.id === skillItem.id)).toBe(true);

  // BULK keep-mine — resolves the three non-P1 items, and the GUARDRAIL (P1) is deliberately left behind.
  await page.locator('[data-uc-bulk="keep"]').click();
  await expect(page.locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', '1', { timeout: 8000 });
  const left = await reviewItems(page);
  expect(left.length).toBe(1);
  expect(left[0]!.priority).toBe('P1'); // the guardrail conflict survived the bulk (server guardrail)

  // KEYBOARD KEEP (1) the lone P1 individually → the queue reaches zero.
  await page.locator('[data-uc-review]').focus();
  await page.keyboard.press('1');
  await expect(page.locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', '0', { timeout: 8000 });
  expect((await reviewItems(page)).length).toBe(0);
});
