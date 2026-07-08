// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant prompt customization over the real admin HTTP API.
 *
 * The acceptance bar: an operator can give one tenant its own copy of a global prompt without touching
 * anyone else's, see who-gets-what (provenance), replace it, and revert it — and a non-admin can't.
 *   • Customize: POST a fork for tenant A → 201, realm='tenant', owner = A.
 *   • Provenance: GET .../realm?tenantId=A → the fork (own_override); a different tenant → the global.
 *   • Copy-on-write: customizing again replaces the fork (one per tenant), never duplicates.
 *   • RBAC: a non-admin user is refused (403).
 *   • Revert: DELETE the fork → the tenant falls back to the global default.
 * Run: npm run test:e2e -- realm-prompt-customize   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'realm-admin@weaveintel.dev';       // first-registered on a fresh DB → admin
const NON_ADMIN = 'realm-user@weaveintel.dev';
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

test('Realm — per-tenant prompt customize, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);

  // The admin must be the FIRST user on the fresh managed DB to be auto-promoted.
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Pick a seeded GLOBAL prompt to customize.
  const list = await (await page.request.get(`${origin}/api/admin/prompts`)).json() as { prompts: Array<{ id: string; realm?: string; logical_key?: string; name: string }> };
  const global = list.prompts.find((p) => (p.realm ?? 'global') === 'global') ?? list.prompts[0];
  expect(global, 'a seeded global prompt exists').toBeTruthy();
  if (!global) throw new Error('no seeded prompt');

  // ── Customize for tenant A ──────────────────────────────────────────────────────────
  const created = await page.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, {
    headers: H,
    data: { tenantId: TENANT_A, template: 'You are Acme Clinic’s clinical assistant. Cite guidelines and flag PHI.' },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string }; replacedExisting: boolean };
  expect(createdBody.fork.realm).toBe('tenant');
  expect(createdBody.fork.owner_tenant_id).toBe(TENANT_A);
  expect(createdBody.fork.origin_id).toBe(global.id);
  expect(createdBody.fork.content_hash).toMatch(/^sha256:/);
  expect(createdBody.replacedExisting).toBe(false);

  // ── Provenance: tenant A sees its fork; tenant B sees the global ─────────────────────
  const provA = await (await page.request.get(`${origin}/api/admin/prompts/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { template: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.template).toContain('Acme Clinic');
  expect(provA.effective.owner_tenant_id).toBe(TENANT_A);

  const provB = await (await page.request.get(`${origin}/api/admin/prompts/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { effective: { template: string }; provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');
  expect(provB.effective.template).not.toContain('Acme Clinic');

  // ── Copy-on-write: customizing again REPLACES the fork (one per tenant) ──────────────
  const replaced = await page.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, template: 'You are Acme Clinic’s assistant — v2.' },
  });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const afterReplace = await (await page.request.get(`${origin}/api/admin/prompts/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { template: string } };
  expect(afterReplace.effective.template).toContain('v2');

  // A tenant copy cannot itself be customized (must fork the global).
  const forkId = createdBody.fork ? (await (await page.request.get(`${origin}/api/admin/prompts/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id : '';
  const nested = await page.request.post(`${origin}/api/admin/prompts/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, template: 'x' } });
  expect(nested.status()).toBe(400);

  // ── RBAC: a non-admin user is refused ───────────────────────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  const forbidden = await otherPage.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, {
    headers: otherH, data: { tenantId: 'sneaky', template: 'nope' },
  });
  expect(forbidden.status()).toBe(403);
  await ctx.close();

  // ── Revert: DELETE the fork → tenant A falls back to the global ──────────────────────
  const del = await page.request.delete(`${origin}/api/admin/prompts/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/prompts/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string }; effective: { template: string } };
  expect(reverted.provenance.kind).toBe('global');
  expect(reverted.effective.template).not.toContain('Acme Clinic');

  // A second revert is a clean 404 (nothing to revert).
  const del2 = await page.request.delete(`${origin}/api/admin/prompts/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del2.status()).toBe(404);
});
