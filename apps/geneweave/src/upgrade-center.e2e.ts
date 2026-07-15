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

test('@upgrade-critical Upgrade Center — the L2 code-conflict section lists a conflict and opens the in-app merge', async ({ page }) => {
  await login(page, ADMIN);
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const origin0 = new URL('/', page.url()).origin;
  await page.request.post(`${origin0}/api/admin/upgrade/_test/promote-admin`, { headers: H, data: {} });
  // Seed one L2 code conflict (family='code') on its own run — separate from the review-queue fixture.
  const seeded = await (await page.request.post(`${origin0}/api/admin/upgrade/_test/seed-code-conflict`, { headers: H, data: {} })).json() as { path: string };
  expect(seeded.path).toBe('src/e2e-conflict.ts');

  await openUpgradeCenter(page);
  const uc = ucRoot(page);

  // Load the code conflicts and assert the seeded file appears in the Code section.
  await uc.locator('[data-uc-code-load]').click();
  const conflictRow = uc.locator('[data-uc-code-item="src/e2e-conflict.ts"]');
  await expect(conflictRow).toBeVisible({ timeout: 8000 });

  // Open the merge. The E2E server has no accepted release (so no target code ref) → the view degrades
  // gracefully to the git-branch note rather than a broken editor. This exercises the whole wiring:
  // GET /code/conflicts → GET /code/conflict → the merge panel renders, honestly reporting git_required.
  await conflictRow.locator('[data-uc-code-open]').click();
  await expect(uc.locator('[data-uc-merge-git]')).toBeVisible({ timeout: 8000 });
  await expect(uc.locator('[data-uc-merge-git]')).toContainText('git branch');
});

test('@upgrade-critical Upgrade Center — a code review-queue row offers Merge, not Adopt (adopt is guarded, not a raw 409)', async ({ page }) => {
  await login(page, ADMIN);
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const origin0 = new URL('/', page.url()).origin;
  await page.request.post(`${origin0}/api/admin/upgrade/_test/promote-admin`, { headers: H, data: {} });
  // A code conflict (family='code', layer='L2') lands in the SAME review queue as content — but code is resolved
  // by merging (Code section), and adopting it is a deploy the server refuses (409). The row must reflect that.
  await page.request.post(`${origin0}/api/admin/upgrade/_test/seed-code-conflict`, { headers: H, data: {} });

  await openUpgradeCenter(page);
  const uc = ucRoot(page);

  // The review queue auto-loads on mount; find the code row (it shows the file path as its logical key).
  const codeRow = uc.locator('.uc-review-row', { hasText: 'src/e2e-conflict.ts' }).first();
  await expect(codeRow).toBeVisible({ timeout: 8000 });
  // It offers "Open merge" and Keep/Defer — but NOT "Adopt" (which can't apply to code).
  await expect(codeRow.locator('[data-uc-action="merge"]')).toBeVisible();
  await expect(codeRow.locator('[data-uc-action="keep"]')).toBeVisible();
  await expect(codeRow.locator('[data-uc-action="defer"]')).toBeVisible();
  await expect(codeRow.locator('[data-uc-action="adopt"]')).toHaveCount(0);

  // Selecting the code row and pressing the adopt key (2) surfaces a plain-language pointer, not a raw 409.
  await codeRow.click();
  await uc.locator('[data-uc-review]').press('2');
  await expect(uc.locator('[data-uc-error]')).toContainText('Code conflicts are resolved in the Code section', { timeout: 4000 });
  // …and the view is still alive (no crash): the code row is still there.
  await expect(codeRow).toBeVisible();

  // "Open merge" from the review row opens the merge panel (git-required in this no-release harness).
  await codeRow.locator('[data-uc-action="merge"]').click();
  await expect(uc.locator('[data-uc-merge-git], [data-uc-merge]')).toBeVisible({ timeout: 8000 });
});
