// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm Phase 2 built-in prompt drift + one-click resync over the real admin
 * HTTP API. The acceptance bar an operator cares about:
 *   • A fresh install reports every built-in prompt "in sync".
 *   • Editing a built-in shows up as "customized" (you changed a shipped default).
 *   • One click ("use the shipped version") resyncs it back to in sync.
 *   • A non-admin can't see the drift report or resync (RBAC).
 * Run: npm run test:e2e -- realm-prompt-drift   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'drift-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'drift-user@weaveintel.dev';

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

type Drift = { summary: Record<string, number>; entries: Array<{ id: string; name: string; state: string; logicalKey: string }> };

test('Realm Phase 2 — built-in prompt drift report + resync + RBAC', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // ── A fresh install is entirely in sync. ─────────────────────────────────────────────
  const d0 = await (await page.request.get(`${origin}/api/admin/prompts/drift`)).json() as Drift;
  expect(d0.entries.length).toBeGreaterThan(0);
  expect((d0.summary['customized'] ?? 0) + (d0.summary['stale'] ?? 0) + (d0.summary['diverged'] ?? 0)).toBe(0);
  expect(d0.summary['in_sync']).toBe(d0.entries.length);

  // Pick a built-in to customize.
  const target = d0.entries[0]!;

  // ── Edit that built-in via the normal admin PUT (does not refresh content_hash — drift is live). ──
  const put = await page.request.put(`${origin}/api/admin/prompts/${target.id}`, {
    headers: H, data: { template: 'You are our house assistant. Follow the internal style guide.' },
  });
  expect(put.ok()).toBeTruthy();

  const d1 = await (await page.request.get(`${origin}/api/admin/prompts/drift`)).json() as Drift;
  const e1 = d1.entries.find((e) => e.id === target.id)!;
  expect(e1.state).toBe('customized');
  expect(d1.summary['customized']).toBe(1);

  // ── One-click resync → take the shipped version → back to in sync. ───────────────────
  const resync = await page.request.post(`${origin}/api/admin/prompts/${target.id}/resync`, { headers: H });
  expect(resync.ok()).toBeTruthy();
  const d2 = await (await page.request.get(`${origin}/api/admin/prompts/drift`)).json() as Drift;
  expect(d2.entries.find((e) => e.id === target.id)!.state).toBe('in_sync');
  expect((d2.summary['customized'] ?? 0)).toBe(0);

  // Resyncing a prompt that has no recorded package version (or a tenant fork) fails cleanly.
  const bad = await page.request.post(`${origin}/api/admin/prompts/not-a-real-id/resync`, { headers: H });
  expect(bad.status()).toBe(404);

  // ── RBAC: a non-admin can neither read the drift report nor resync. ──────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.get(`${origin}/api/admin/prompts/drift`)).status()).toBe(403);
  expect((await otherPage.request.post(`${origin}/api/admin/prompts/${target.id}/resync`, { headers: otherH })).status()).toBe(403);
  await ctx.close();
});
