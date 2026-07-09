// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm Phase 3 per-tenant state overlay (SetState) over the real admin HTTP
 * API. The acceptance bar: an operator can turn a shared built-in off for one tenant, reprioritise it,
 * list it, clear it, with validation and RBAC — and no fork is ever created.
 * Run: npm run test:e2e -- realm-tenant-state   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'state-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'state-user@weaveintel.dev';
const TENANT = 'acme-clinic';
const KEY = 'skill.web-search';

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

test('Realm Phase 3 — per-tenant state overlay: set / list / merge / validate / clear / RBAC', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // ── Turn a shared skill OFF for one tenant. ──────────────────────────────────────────
  const off = await page.request.put(`${origin}/api/admin/realm-state`, {
    headers: H, data: { family: 'skills', logicalKey: KEY, tenantId: TENANT, enabled: false },
  });
  expect(off.status()).toBe(200);
  expect((await off.json() as { state: { enabled: boolean } }).state.enabled).toBe(false);

  // List shows the tenant's overlay.
  const list1 = await (await page.request.get(`${origin}/api/admin/realm-state?family=skills&tenantId=${TENANT}`)).json() as { states: Array<{ logicalKey: string; enabled: boolean }> };
  expect(list1.states.find((s) => s.logicalKey === KEY)?.enabled).toBe(false);

  // ── Merge in a priority (a partial patch keeps the disable). ─────────────────────────
  const prio = await page.request.put(`${origin}/api/admin/realm-state`, {
    headers: H, data: { family: 'skills', logicalKey: KEY, tenantId: TENANT, priority: 5 },
  });
  const merged = (await prio.json() as { state: { enabled: boolean; priority: number } }).state;
  expect([merged.enabled, merged.priority]).toEqual([false, 5]);

  // Another tenant has no overlay — the shared default is untouched.
  const other = await (await page.request.get(`${origin}/api/admin/realm-state?family=skills&tenantId=globex`)).json() as { states: unknown[] };
  expect(other.states).toHaveLength(0);

  // ── Validation. ─────────────────────────────────────────────────────────────────────
  expect((await page.request.put(`${origin}/api/admin/realm-state`, { headers: H, data: { family: 'nonsense', logicalKey: KEY, tenantId: TENANT, enabled: false } })).status()).toBe(400);
  expect((await page.request.put(`${origin}/api/admin/realm-state`, { headers: H, data: { family: 'skills', tenantId: TENANT, enabled: false } })).status()).toBe(400); // no logicalKey

  // ── Clear → back to the shared default. ─────────────────────────────────────────────
  const del = await page.request.delete(`${origin}/api/admin/realm-state?family=skills&logicalKey=${KEY}&tenantId=${TENANT}`, { headers: H });
  expect(del.status()).toBe(200);
  const list2 = await (await page.request.get(`${origin}/api/admin/realm-state?family=skills&tenantId=${TENANT}`)).json() as { states: unknown[] };
  expect(list2.states).toHaveLength(0);

  // ── RBAC: a non-admin can neither set nor list overlays. ────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.put(`${origin}/api/admin/realm-state`, { headers: otherH, data: { family: 'skills', logicalKey: KEY, tenantId: 'sneaky', enabled: false } })).status()).toBe(403);
  expect((await otherPage.request.get(`${origin}/api/admin/realm-state?family=skills&tenantId=${TENANT}`)).status()).toBe(403);
  await ctx.close();
});
