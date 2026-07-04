// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — CLS & performance (m144, Round 8): scroll preservation + loading skeletons.
 *
 * Proves (no LLM needed — UI behaviour):
 *   • Config round-trip: the per-tenant "show loading skeletons" preference round-trips (admin ↔ /api/me).
 *   • Scroll preservation: a scrolled container (the notes list) keeps its position across a full re-render,
 *     instead of jumping to the top (the H14 class of bug, now fixed for every [data-scroll-key] container).
 *   • Loading skeletons: a slow view shows placeholder skeletons (role="status") instead of a blank flash.
 * Run: npm run test:e2e -- perf-cls   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'pc-owner@weaveintel.dev';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'pc', email: OWNER, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: OWNER, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}
function noteDoc(title: string) {
  return { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }] };
}

// ── Config round-trip ─────────────────────────────────────────────────────────────────
test('CLS — the "show loading skeletons" preference round-trips', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  const def = await (await page.request.get(`${origin}/api/me/accessibility`)).json() as { showSkeletons: boolean };
  expect(def.showSkeletons).toBe(true);

  const put = await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { show_skeletons: 0 } });
  expect(put.status()).toBe(200);
  expect((await (await page.request.get(`${origin}/api/admin/accessibility/default`)).json() as { tenants: Record<string, unknown> }).tenants['show_skeletons']).toBe(0);
  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { show_skeletons: 1 } });
});

// ── Scroll preservation across a full re-render ───────────────────────────────────────
test('CLS — a scrolled list keeps its position across a re-render (no jump to top)', async ({ page }) => {
  test.setTimeout(90_000);
  const { origin, H } = await login(page);
  // Enough notes that the list is scrollable, and a short viewport so it definitely overflows.
  for (let i = 0; i < 30; i++) await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: `Perf note ${String(i).padStart(2, '0')}`, doc_json: noteDoc(`Perf note ${i}`) } });
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.reload();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });

  // Open Notes; a search fills the list (the nav alone doesn't load it).
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  const search = page.locator('input[placeholder="Search notes"], input[placeholder*="Search notes"], .notes-search-input').first();
  await expect(search).toBeVisible({ timeout: 8000 });
  await search.fill('Perf note');
  const list = page.locator('[data-scroll-key="notes-list"]');
  await expect(list).toBeVisible({ timeout: 8000 });
  await expect(list.getByText('Perf note 00', { exact: false })).toBeVisible({ timeout: 8000 });
  await expect.poll(async () => list.evaluate((el) => el.scrollHeight > el.clientHeight + 20), { timeout: 6000 }).toBe(true);

  // Scroll it, then trigger a full re-render — the list must NOT jump back to the top.
  await list.evaluate((el) => { el.scrollTop = 120; });
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(80);
  await page.evaluate(() => (window as unknown as { render?: () => void }).render?.());
  await expect.poll(async () => page.locator('[data-scroll-key="notes-list"]').evaluate((el) => el.scrollTop), { timeout: 4000 }).toBeGreaterThan(80);
  await page.screenshot({ path: '/tmp/pw-cls-scroll.png' });
});

// ── Loading skeletons on a slow view ──────────────────────────────────────────────────
test('CLS — a slow view shows loading skeletons, not a blank flash', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  // Make the dashboard data hang so the view stays in its loading state, then force it to render.
  await page.route('**/api/dashboard/**', () => { /* never fulfil → state.dashboard stays null */ });
  await page.evaluate(() => { const w = window as unknown as { state?: { view: string }; render?: () => void }; if (w.state) w.state.view = 'dashboard'; w.render?.(); });

  const skel = page.locator('.dash-view .skel-grid, .dash-view .skel').first();
  await expect(skel).toBeVisible({ timeout: 8000 });
  await expect(skel).toHaveAttribute('role', 'status');
  await page.screenshot({ path: '/tmp/pw-cls-skeleton.png' });
  await page.unroute('**/api/dashboard/**');
});
