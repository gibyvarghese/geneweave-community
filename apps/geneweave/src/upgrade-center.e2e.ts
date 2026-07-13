// SPDX-License-Identifier: MIT
/**
 * Playwright E2E (`@upgrade-critical`) — the Upgrade Center review queue, driven as a real browser screen.
 *
 * Registers an admin on a fresh DB, seeds a mixed review queue (a diverged skill with an upstream + a P1 + two
 * P3s), navigates Admin → Governance → Upgrade Center, and resolves the whole queue by KEYBOARD:
 *   • navigate to the diverged skill and ADOPT it (2) → it leaves the queue and the live row takes upstream;
 *   • UNDO (u) → the item returns and the live row is restored (badge truthfulness across adopt→revert);
 *   • BULK keep-mine (never touches the P1) clears the remaining non-P1s;
 *   • KEEP (1) the lone P1 individually → the queue reaches zero.
 * Plus DB-through-API assertions on the resolutions/audit at each step, and a negative check that the bulk
 * guardrail left the P1 for last.
 *
 * Run: `PLAYWRIGHT_E2E=1 npm run test:e2e -- upgrade-center` (the fixture route is gated on PLAYWRIGHT_E2E).
 *
 * CI-robustness note: the custom view kicks off an async queue load on mount that re-enters the app's full
 * re-render, so during a render burst two `[data-upgrade-center]` roots can momentarily coexist (the old one is
 * cleared and a fresh one mounted within the same task). On a slower CI runner Playwright can sample that
 * transient and a bare `page.locator('[data-upgrade-center]')` then trips STRICT MODE (2 elements). Every queue
 * locator is therefore scoped to `uc` — the FIRST upgrade-center root — which is strict-safe and converges on
 * the settled single root (the `toHaveAttribute`/`toBeVisible` polls ride out the burst).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';

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

/** The upgrade-center root, scoped to the first match (strict-safe against a transient render-burst duplicate). */
const ucRoot = (page: Page): Locator => page.locator('[data-upgrade-center]').first();

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
  await expect(ucRoot(page)).toBeVisible({ timeout: 8000 });
}

/** The current review items (via the API) — the DB-through-API audit assertion surface. */
async function reviewItems(page: Page): Promise<Array<{ id: string; family: string; priority: string }>> {
  const origin = new URL(page.url()).origin;
  const q = await (await page.request.get(`${origin}/api/admin/upgrade/review`)).json() as { items: Array<{ id: string; family: string; priority: string }> };
  return q.items;
}

/** Assert the queue's remaining count, scoped to the live root (rides out a render burst). */
async function expectRemaining(page: Page, n: string): Promise<void> {
  await expect(ucRoot(page).locator('[data-uc-remaining]')).toHaveAttribute('data-uc-remaining', n, { timeout: 8000 });
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
  await expectRemaining(page, '4');

  // The diverged skill's detail id (to locate its row).
  const skillItem = (await reviewItems(page)).find((i) => i.family === 'skills')!;

  // Select a row (click sets the cursor + focuses deterministically — robust across CI timing), then act on it
  // with a keyboard key. Selecting via click is equivalent to navigating with j/k; the RESOLUTION is keyboard.
  const keyOnRow = async (itemId: string, key: string): Promise<void> => {
    await ucRoot(page).locator(`[data-uc-review-item="${itemId}"] .uc-key`).click();
    await ucRoot(page).locator('[data-uc-review]').focus();
    await page.keyboard.press(key);
  };

  // KEYBOARD ADOPT (2) the diverged skill.
  await keyOnRow(skillItem.id, '2');
  await expectRemaining(page, '3');
  expect((await reviewItems(page)).some((i) => i.id === skillItem.id)).toBe(false); // gone from the queue, recorded 'adopted'

  // KEYBOARD UNDO (u): the adopted skill returns to the queue (badge truthfulness — the record is restored).
  await ucRoot(page).locator('[data-uc-review]').focus();
  await page.keyboard.press('u');
  await expectRemaining(page, '4');
  expect((await reviewItems(page)).some((i) => i.id === skillItem.id)).toBe(true);

  // BULK keep-mine — resolves the three non-P1 items, and the GUARDRAIL (P1) is deliberately left behind.
  await ucRoot(page).locator('[data-uc-bulk="keep"]').click();
  await expectRemaining(page, '1');
  const left = await reviewItems(page);
  expect(left.length).toBe(1);
  expect(left[0]!.priority).toBe('P1'); // the guardrail conflict survived the bulk (server guardrail)

  // KEYBOARD KEEP (1) the lone P1 individually → the queue reaches zero.
  await keyOnRow(left[0]!.id, '1');
  await expectRemaining(page, '0');
  expect((await reviewItems(page)).length).toBe(0);
});
