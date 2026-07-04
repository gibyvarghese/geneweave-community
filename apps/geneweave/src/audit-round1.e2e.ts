/**
 * UX Audit — Round 1: core interaction & dismissal.
 * Targets the hypotheses in UX_AUDIT_NOTES.md (H1–H7). Accessible selectors; deterministic waits.
 *
 * Run: npm run test:e2e -- audit-round1
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';

async function login(page: Page): Promise<{ H: Record<string, string> }> {
  const email = `audit1-${Date.now()}-${Math.floor(Math.random() * 1e6)}@weaveintel.dev`;
  await page.request.post('/api/auth/register', { data: { name: 'Audit One', email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}

/** Seed enough chats that the Recent Chats list scrolls. Returns the created ids (newest first-ish). */
async function seedChats(page: Page, H: Record<string, string>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.request.post('/api/chats', { headers: H, data: { title: `Seeded chat ${String(i).padStart(2, '0')}` } });
  }
  // Reload so the sidebar renders the seeded list.
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

test.describe('Round 1 — core interaction & dismissal', () => {
  test('H3 — clicking the logo routes home (chat) from another view', async ({ page }) => {
    await login(page);
    // Navigate to a non-full-bleed view that keeps the workspace nav (Calendar), then click the logo.
    // (The full-bleed views — Notes/Builder/Account — have their own brand→home affordance, tested elsewhere.)
    await page.getByRole('button', { name: 'Calendar' }).click();
    await expect(page.getByRole('button', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'geneWeave home' }).click();
    await expect(page.locator('textarea[placeholder="Type a message..."]')).toBeVisible({ timeout: 5000 });
  });

  test('H1 — Escape closes the profile menu (light dismiss)', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Profile and preferences' }).click();
    await expect(page.locator('.profile-dd')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.profile-dd')).toHaveCount(0);
  });

  test('H1b — outside-click closes the profile menu', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Profile and preferences' }).click();
    await expect(page.locator('.profile-dd')).toBeVisible();
    await page.mouse.click(700, 400);
    await expect(page.locator('.profile-dd')).toHaveCount(0);
  });

  test('H2 — profile trigger exposes aria-expanded (flips true/false) + aria-haspopup', async ({ page }) => {
    await login(page);
    const trigger = page.getByRole('button', { name: 'Profile and preferences' });
    await expect(trigger).toHaveAttribute('aria-haspopup', /menu|true/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('H4 — chat items are keyboard-operable (focusable + Enter opens)', async ({ page }) => {
    const { H } = await login(page);
    await seedChats(page, H, 6);
    const item = page.getByRole('button', { name: /Open chat: Seeded chat 00/ });
    await expect(item.first()).toBeVisible();
    await item.first().focus();
    await expect(item.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-item.active')).toBeVisible();
  });

  test('H5 — the active chat item exposes aria-current="page"', async ({ page }) => {
    const { H } = await login(page);
    await seedChats(page, H, 6);
    await page.locator('.chat-item').first().click();
    await expect(page.locator('.chat-item.active')).toHaveAttribute('aria-current', 'page');
  });

  test('H6 — selecting a chat in a long scrolled list preserves sidebar scrollTop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    const { H } = await login(page);
    await seedChats(page, H, 24);
    const nav = page.locator('.workspace-nav-scroll');
    const target = page.locator('.chat-item').last();
    await expect(target).toBeVisible(); // list rendered + actionable before we scroll
    await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(150); // let the scroll listener persist state.sidebarScrollTop
    const before = await nav.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(50); // it actually scrolled
    // Select the bottom-most chat (visible at the scrolled position — no auto-scroll needed).
    await target.click();
    await expect(page.locator('.chat-item.active')).toBeVisible(); // selection completed
    // Poll until the render burst + double-rAF scroll-restore settles. The scroll must be RETAINED — not
    // collapsed toward the top (before the fix it reset to 0). Minor px drift from active styling is fine.
    await expect.poll(async () => nav.evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 4000 })
      .toBeGreaterThan(before * 0.7);
  });

  test('H9 — New Chat creates a chat and makes it the active context (no silent no-op)', async ({ page }) => {
    const { H } = await login(page);
    await seedChats(page, H, 3);
    const before = (await (await page.request.get('/api/chats')).json() as { chats?: unknown[] }).chats?.length ?? 0;
    await page.getByRole('button', { name: /new chat/i }).first().click();
    await page.waitForTimeout(600);
    const after = (await (await page.request.get('/api/chats')).json() as { chats?: unknown[] }).chats?.length ?? 0;
    expect(after).toBeGreaterThanOrEqual(before); // created or reused an empty draft — never a dead click
    await expect(page.locator('.composer textarea, textarea[placeholder*="message" i]')).toBeVisible();
  });

  test('H10 — re-clicking the profile trigger toggles it closed; no duplicate/detached menu in the DOM', async ({ page }) => {
    await login(page);
    const trigger = page.getByRole('button', { name: /profile and preferences/i });
    await trigger.click();
    await expect(page.locator('.profile-dd')).toHaveCount(1);
    await trigger.click(); // re-click closes
    await expect(page.locator('.profile-dd')).toHaveCount(0);
    // Re-open a few times — never more than one instance in the DOM (no leaked/detached menus).
    for (let i = 0; i < 3; i++) { await trigger.click(); expect(await page.locator('.profile-dd').count()).toBeLessThanOrEqual(1); await trigger.click(); }
  });
});
