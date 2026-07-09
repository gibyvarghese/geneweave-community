// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm Phase 4 sharing + promotion over the real admin HTTP API: preview a
 * share's blast radius, share a fork down the tree, promote a fork to the global default, with
 * validation and RBAC.
 * Run: npm run test:e2e -- realm-hierarchy   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'hier-admin@weaveintel.dev';
const NON_ADMIN = 'hier-user@weaveintel.dev';
const TENANT = 'acme-clinic';

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

test('Realm Phase 4 — blast radius + share + promote + validation + RBAC', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // A global prompt to work with.
  const list = await (await page.request.get(`${origin}/api/admin/prompts`)).json() as { prompts: Array<{ id: string; realm?: string }> };
  const global = list.prompts.find((p) => (p.realm ?? 'global') === 'global')!;

  // Tenant forks it.
  const forkRes = await page.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT, template: 'FORK CONTENT — house style' },
  });
  expect(forkRes.status()).toBe(201);
  const forkId = (await forkRes.json() as { fork: { id: string } }).fork.id;

  // ── Blast radius preview (valid structure; this tenant is a root with no children yet). ──
  const br = await page.request.get(`${origin}/api/admin/prompts/${forkId}/blast-radius?shareMode=subtree`);
  expect(br.status()).toBe(200);
  const radius = (await br.json() as { blastRadius: { shareMode: string; inheriting: string[]; shadowed: string[] } }).blastRadius;
  expect(radius.shareMode).toBe('subtree');
  expect(Array.isArray(radius.inheriting)).toBe(true);

  // ── Share the fork down the subtree. ─────────────────────────────────────────────────
  const share = await page.request.post(`${origin}/api/admin/prompts/${forkId}/share`, { headers: H, data: { shareMode: 'subtree' } });
  expect(share.status()).toBe(200);
  expect((await share.json() as { shareMode: string }).shareMode).toBe('subtree');

  // ── Promote the fork to the shared global default. ───────────────────────────────────
  const promote = await page.request.post(`${origin}/api/admin/prompts/${forkId}/promote`, { headers: H });
  expect(promote.status()).toBe(200);
  // The GLOBAL prompt now carries the fork's content.
  const globalNow = await (await page.request.get(`${origin}/api/admin/prompts/${global.id}`)).json() as { prompt: { template: string } };
  expect(globalNow.prompt.template).toContain('FORK CONTENT');

  // ── Validation. ─────────────────────────────────────────────────────────────────────
  expect((await page.request.get(`${origin}/api/admin/prompts/${forkId}/blast-radius?shareMode=nonsense`)).status()).toBe(400);
  // A global prompt isn't a fork — can't be shared or promoted.
  expect((await page.request.post(`${origin}/api/admin/prompts/${global.id}/share`, { headers: H, data: { shareMode: 'subtree' } })).status()).toBe(400);
  expect((await page.request.post(`${origin}/api/admin/prompts/${global.id}/promote`, { headers: H })).status()).toBe(400);
  expect((await page.request.post(`${origin}/api/admin/prompts/not-real/promote`, { headers: H })).status()).toBe(404);

  // ── RBAC: a non-admin can neither preview, share nor promote. ────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.get(`${origin}/api/admin/prompts/${forkId}/blast-radius?shareMode=subtree`)).status()).toBe(403);
  expect((await otherPage.request.post(`${origin}/api/admin/prompts/${forkId}/share`, { headers: otherH, data: { shareMode: 'subtree' } })).status()).toBe(403);
  expect((await otherPage.request.post(`${origin}/api/admin/prompts/${forkId}/promote`, { headers: otherH })).status()).toBe(403);
  await ctx.close();
});
