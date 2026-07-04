import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? ADMIN_EMAIL;
  await page.goto('/');

  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });

  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'Sidebar Scroll User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());

    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 5000 });
}

async function goAdmin(page: Page) {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
}

test('sidebar scroll stays stable when selecting admin subtab', async ({ page }) => {
  await registerAndEnter(page);
  await goAdmin(page);

  await expect(page.locator('.workspace-nav-scroll')).toBeVisible();

  // Open all admin groups; each click re-renders, so query fresh each iteration.
  for (let i = 0; i < 24; i += 1) {
    const closedGroup = page.locator('.admin-group-btn:has(.admin-caret:not(.open))').first();
    const hasClosed = await closedGroup.isVisible().catch(() => false);
    if (!hasClosed) break;
    await closedGroup.click();
    await page.waitForTimeout(80);
  }

  await page.waitForTimeout(100);

  const nav = page.locator('.workspace-nav-scroll');
  await nav.evaluate((el) => {
    const node = el as HTMLElement;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  });

  await page.waitForTimeout(100);

  const tabs = page.locator('.admin-subtab');
  const tabCount = await tabs.count();
  expect(tabCount).toBeGreaterThan(5);

  const before = await nav.evaluate((el) => {
    const node = el as HTMLElement;
    return {
      navScrollTop: node.scrollTop,
      bodyScrollY: window.scrollY,
      navClientHeight: node.clientHeight,
      navScrollHeight: node.scrollHeight,
    };
  });
  expect(before.navScrollTop).toBeGreaterThan(0);

  await tabs.nth(tabCount - 1).click();
  await expect(page.locator('.admin-subtab.active')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(250);

  const after = await nav.evaluate((el) => {
    const node = el as HTMLElement;
    return {
      navScrollTop: node.scrollTop,
      bodyScrollY: window.scrollY,
      navClientHeight: node.clientHeight,
      navScrollHeight: node.scrollHeight,
      activeTab: (document.querySelector('.admin-subtab.active') as HTMLElement | null)?.getAttribute('data-admin-tab') || null,
    };
  });

  expect(after.activeTab).toBeTruthy();
  expect(after.navScrollTop).toBeGreaterThan(0);
  expect(Math.abs(after.navScrollTop - before.navScrollTop)).toBeLessThan(before.navClientHeight);
  expect(Math.abs(after.bodyScrollY - before.bodyScrollY)).toBeLessThanOrEqual(2);
});
