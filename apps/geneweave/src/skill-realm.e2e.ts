// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant SKILL customization over the real admin HTTP API.
 *   • Customize: POST a fork for tenant A → 201, realm='tenant', owner = A.
 *   • Provenance: GET .../realm?tenantId=A → the fork (own_override); another tenant → the global.
 *   • Copy-on-write: customizing again replaces the fork; a tenant copy can't itself be customized.
 *   • RBAC: a non-admin is refused (403). Revert: DELETE → falls back to the global built-in.
 * Run: npm run test:e2e -- skill-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'skill-admin@weaveintel.dev';
const NON_ADMIN = 'skill-user@weaveintel.dev';
const TENANT_A = 'acme-clinic';
const TENANT_B = 'globex-bank';

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

test('Realm — per-tenant skill customize, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const list = await (await page.request.get(`${origin}/api/admin/skills`)).json() as { skills: Array<{ id: string; realm?: string }> };
  const global = list.skills.find((s) => (s.realm ?? 'global') === 'global') ?? list.skills[0];
  expect(global, 'a seeded global skill exists').toBeTruthy();
  if (!global) throw new Error('no seeded skill');

  // ── Customize for tenant A ──────────────────────────────────────────────────────────
  const created = await page.request.post(`${origin}/api/admin/skills/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, instructions: 'ACME house rules: always cite guidelines and flag PHI.' },
  });
  expect(created.status()).toBe(201);
  const fork = (await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string } }).fork;
  expect(fork.realm).toBe('tenant');
  expect(fork.owner_tenant_id).toBe(TENANT_A);
  expect(fork.origin_id).toBe(global.id);
  expect(fork.content_hash).toMatch(/^sha256:/);

  // ── Provenance: A sees its fork; B sees the global ──────────────────────────────────
  const provA = await (await page.request.get(`${origin}/api/admin/skills/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { instructions: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.instructions).toContain('ACME house rules');
  expect(provA.effective.owner_tenant_id).toBe(TENANT_A);
  const provB = await (await page.request.get(`${origin}/api/admin/skills/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { effective: { instructions: string }; provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');
  expect(provB.effective.instructions).not.toContain('ACME house rules');

  // ── Copy-on-write: customizing again REPLACES the fork; a tenant copy can't be re-customized. ──
  const replaced = await page.request.post(`${origin}/api/admin/skills/${global.id}/customize`, { headers: H, data: { tenantId: TENANT_A, instructions: 'ACME v2 rules.' } });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const forkId = (await (await page.request.get(`${origin}/api/admin/skills/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  expect((await page.request.post(`${origin}/api/admin/skills/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, instructions: 'x' } })).status()).toBe(400);

  // ── RBAC: a non-admin is refused ────────────────────────────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.post(`${origin}/api/admin/skills/${global.id}/customize`, { headers: otherH, data: { tenantId: 'sneaky', instructions: 'nope' } })).status()).toBe(403);
  await ctx.close();

  // ── Revert: DELETE → tenant A falls back to the global built-in ─────────────────────
  const del = await page.request.delete(`${origin}/api/admin/skills/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/skills/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string } };
  expect(reverted.provenance.kind).toBe('global');
  expect((await page.request.delete(`${origin}/api/admin/skills/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H })).status()).toBe(404);
});
