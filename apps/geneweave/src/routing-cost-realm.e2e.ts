// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant ROUTING-POLICY and COST-POLICY customization over the real
 * admin HTTP API. Each: an operator forks a global policy for one tenant, sees provenance, replaces it
 * (copy-on-write), a non-admin is refused, and a revert falls back to the global.
 * Run: npm run test:e2e -- routing-cost-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'routingcost-realm-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'routingcost-realm-user@weaveintel.dev';
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

test('Realm — per-tenant routing-policy customize, effective set, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const list = await (await page.request.get(`${origin}/api/admin/routing`)).json() as { policies: Array<{ id: string; realm?: string; logical_key?: string; name: string; strategy?: string }> };
  const global = list.policies.find((p) => (p.realm ?? 'global') === 'global') ?? list.policies[0];
  expect(global, 'a seeded global routing policy exists').toBeTruthy();
  if (!global) throw new Error('no seeded routing policy');
  const canonicalName = global.logical_key ?? global.name;

  const created = await page.request.post(`${origin}/api/admin/routing/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, strategy: 'quality', weights: { cost: 0.1, quality: 0.8, latency: 0.1 } },
  });
  expect(created.status()).toBe(201);
  const cb = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; name: string; logical_key: string; strategy: string }; replacedExisting: boolean };
  expect(cb.fork.realm).toBe('tenant');
  expect(cb.fork.owner_tenant_id).toBe(TENANT_A);
  expect(cb.fork.origin_id).toBe(global.id);
  expect(cb.fork.content_hash).toMatch(/^sha256:/);
  expect(cb.fork.name).toBe(canonicalName); // no UNIQUE(name) → keeps the name
  expect(cb.fork.logical_key).toBe(canonicalName);
  expect(cb.fork.strategy).toBe('quality');
  expect(cb.replacedExisting).toBe(false);

  const setA = await (await page.request.get(`${origin}/api/admin/routing?tenantId=${TENANT_A}`)).json() as { policies: Array<{ name: string; logical_key?: string; strategy?: string }> };
  const aP = setA.policies.find((p) => (p.logical_key ?? p.name) === canonicalName)!;
  expect(aP.strategy).toBe('quality');
  expect(setA.policies.filter((p) => (p.logical_key ?? p.name) === canonicalName).length).toBe(1);
  const setB = await (await page.request.get(`${origin}/api/admin/routing?tenantId=${TENANT_B}`)).json() as { policies: Array<{ name: string; logical_key?: string; strategy?: string }> };
  expect(setB.policies.find((p) => (p.logical_key ?? p.name) === canonicalName)!.strategy).toBe(global.strategy);

  const provA = await (await page.request.get(`${origin}/api/admin/routing/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { strategy: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.strategy).toBe('quality');
  const provB = await (await page.request.get(`${origin}/api/admin/routing/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');

  const replaced = await page.request.post(`${origin}/api/admin/routing/${global.id}/customize`, { headers: H, data: { tenantId: TENANT_A, strategy: 'cost' } });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  expect((await (await page.request.get(`${origin}/api/admin/routing/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { strategy: string } }).effective.strategy).toBe('cost');

  const forkId = (await (await page.request.get(`${origin}/api/admin/routing/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  expect((await page.request.post(`${origin}/api/admin/routing/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, strategy: 'cost' } })).status()).toBe(400);

  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.post(`${origin}/api/admin/routing/${global.id}/customize`, { headers: otherH, data: { tenantId: 'sneaky', strategy: 'cost' } })).status()).toBe(403);
  await ctx.close();

  expect((await page.request.delete(`${origin}/api/admin/routing/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H })).status()).toBe(200);
  expect((await (await page.request.get(`${origin}/api/admin/routing/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string } }).provenance.kind).toBe('global');
  expect((await page.request.delete(`${origin}/api/admin/routing/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H })).status()).toBe(404);
});

test('Realm — per-tenant cost-policy customize, effective set, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const list = await (await page.request.get(`${origin}/api/admin/cost-policies`)).json() as { policies: Array<{ id: string; realm?: string; logical_key?: string; key: string; tier?: string }> };
  const global = list.policies.find((p) => p.key === 'balanced') ?? list.policies.find((p) => (p.realm ?? 'global') === 'global') ?? list.policies[0];
  expect(global, 'a seeded global cost policy exists').toBeTruthy();
  if (!global) throw new Error('no seeded cost policy');
  const canonicalKey = global.logical_key ?? global.key;

  const created = await page.request.post(`${origin}/api/admin/cost-policies/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, tier: 'economy', levers_json: { budgetCeilingUsd: 1 } },
  });
  expect(created.status()).toBe(201);
  const cb = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; key: string; logical_key: string; tier: string }; replacedExisting: boolean };
  expect(cb.fork.realm).toBe('tenant');
  expect(cb.fork.owner_tenant_id).toBe(TENANT_A);
  expect(cb.fork.origin_id).toBe(global.id);
  expect(cb.fork.content_hash).toMatch(/^sha256:/);
  expect(cb.fork.key).toBe(`${canonicalKey}#${TENANT_A}`); // UNIQUE(key) → tenant-scoped alias
  expect(cb.fork.logical_key).toBe(canonicalKey);
  expect(cb.fork.tier).toBe('economy');
  expect(cb.replacedExisting).toBe(false);

  const setA = await (await page.request.get(`${origin}/api/admin/cost-policies?tenantId=${TENANT_A}`)).json() as { policies: Array<{ key: string; logical_key?: string; tier?: string }> };
  const aP = setA.policies.find((p) => (p.logical_key ?? p.key) === canonicalKey)!;
  expect(aP.key).toBe(canonicalKey); // canonical key restored
  expect(aP.tier).toBe('economy');
  expect(setA.policies.filter((p) => (p.logical_key ?? p.key) === canonicalKey).length).toBe(1);
  const setB = await (await page.request.get(`${origin}/api/admin/cost-policies?tenantId=${TENANT_B}`)).json() as { policies: Array<{ key: string; logical_key?: string; tier?: string }> };
  expect(setB.policies.find((p) => (p.logical_key ?? p.key) === canonicalKey)!.tier).toBe(global.tier);

  const provA = await (await page.request.get(`${origin}/api/admin/cost-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { tier: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.tier).toBe('economy');
  const provB = await (await page.request.get(`${origin}/api/admin/cost-policies/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');

  const replaced = await page.request.post(`${origin}/api/admin/cost-policies/${global.id}/customize`, { headers: H, data: { tenantId: TENANT_A, tier: 'max' } });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  expect((await (await page.request.get(`${origin}/api/admin/cost-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { tier: string } }).effective.tier).toBe('max');

  const forkId = (await (await page.request.get(`${origin}/api/admin/cost-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  expect((await page.request.post(`${origin}/api/admin/cost-policies/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, tier: 'economy' } })).status()).toBe(400);

  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  expect((await otherPage.request.post(`${origin}/api/admin/cost-policies/${global.id}/customize`, { headers: otherH, data: { tenantId: 'sneaky', tier: 'economy' } })).status()).toBe(403);
  await ctx.close();

  expect((await page.request.delete(`${origin}/api/admin/cost-policies/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H })).status()).toBe(200);
  expect((await (await page.request.get(`${origin}/api/admin/cost-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string } }).provenance.kind).toBe('global');
  expect((await page.request.delete(`${origin}/api/admin/cost-policies/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H })).status()).toBe(404);
});
