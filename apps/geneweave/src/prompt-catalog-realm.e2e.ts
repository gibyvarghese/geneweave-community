// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant PROMPT CATALOG customization over the real admin HTTP API
 * (prompt strategies + prompt frameworks; both seed built-in globals). Each: an operator forks a global
 * for one tenant, sees the effective set + provenance, replaces it (copy-on-write), a non-admin is
 * refused, and a revert falls back to the global. UNIQUE(key) stays intact via the `key#tenant` alias.
 * Run: npm run test:e2e -- prompt-catalog-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'catalog-realm-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'catalog-realm-user@weaveintel.dev';
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

/** Drives the generic catalog customize flow for one table (base path + listKey + an override field). */
async function runCatalogRealmFlow(page: Page, browser: import('@playwright/test').Browser, opts: {
  base: string; listKey: string; overrideField: string; valueA: unknown; valueB: unknown;
}): Promise<void> {
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const list = await (await page.request.get(`${origin}/api/admin/${opts.base}`)).json() as Record<string, Array<{ id: string; realm?: string; logical_key?: string; key: string }>>;
  const rows = list[opts.listKey]!;
  const global = rows.find((r) => (r.realm ?? 'global') === 'global') ?? rows[0];
  expect(global, `a seeded global ${opts.base} exists`).toBeTruthy();
  if (!global) throw new Error(`no seeded ${opts.base}`);
  const canonicalKey = global.logical_key ?? global.key;

  // Customize for tenant A.
  const created = await page.request.post(`${origin}/api/admin/${opts.base}/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, [opts.overrideField]: opts.valueA },
  });
  expect(created.status(), `${opts.base} customize`).toBe(201);
  const cb = await created.json() as { fork: Record<string, unknown> & { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; key: string; logical_key: string }; replacedExisting: boolean };
  expect(cb.fork.realm).toBe('tenant');
  expect(cb.fork.owner_tenant_id).toBe(TENANT_A);
  expect(cb.fork.origin_id).toBe(global.id);
  expect(cb.fork.content_hash).toMatch(/^sha256:/);
  expect(cb.fork.key).toBe(`${canonicalKey}#${TENANT_A}`); // UNIQUE(key) → tenant-scoped alias
  expect(cb.fork.logical_key).toBe(canonicalKey);
  expect(cb.replacedExisting).toBe(false);

  // Effective set: A sees the fork under the canonical key; B keeps the global.
  const setA = await (await page.request.get(`${origin}/api/admin/${opts.base}?tenantId=${TENANT_A}`)).json() as Record<string, Array<Record<string, unknown> & { key: string; logical_key?: string }>>;
  const aRow = setA[opts.listKey]!.find((r) => (r.logical_key ?? r.key) === canonicalKey)!;
  expect(aRow.key).toBe(canonicalKey);                     // canonical key restored
  expect(aRow[opts.overrideField]).toBe(opts.valueA);
  expect(setA[opts.listKey]!.filter((r) => (r.logical_key ?? r.key) === canonicalKey).length).toBe(1);
  const setB = await (await page.request.get(`${origin}/api/admin/${opts.base}?tenantId=${TENANT_B}`)).json() as Record<string, Array<Record<string, unknown> & { key: string; logical_key?: string }>>;
  const bRow = setB[opts.listKey]!.find((r) => (r.logical_key ?? r.key) === canonicalKey)!;
  expect(bRow[opts.overrideField]).not.toBe(opts.valueA);

  // Provenance.
  const provA = await (await page.request.get(`${origin}/api/admin/${opts.base}/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: Record<string, unknown>; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective[opts.overrideField]).toBe(opts.valueA);
  const provB = await (await page.request.get(`${origin}/api/admin/${opts.base}/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');

  // Copy-on-write: customizing again replaces the fork.
  const replaced = await page.request.post(`${origin}/api/admin/${opts.base}/${global.id}/customize`, { headers: H, data: { tenantId: TENANT_A, [opts.overrideField]: opts.valueB } });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const afterReplace = await (await page.request.get(`${origin}/api/admin/${opts.base}/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: Record<string, unknown> };
  expect(afterReplace.effective[opts.overrideField]).toBe(opts.valueB);

  // A tenant copy cannot itself be customized.
  const forkId = (await (await page.request.get(`${origin}/api/admin/${opts.base}/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  const nested = await page.request.post(`${origin}/api/admin/${opts.base}/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, [opts.overrideField]: opts.valueA } });
  expect(nested.status()).toBe(400);

  // RBAC: non-admin refused.
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  const forbidden = await otherPage.request.post(`${origin}/api/admin/${opts.base}/${global.id}/customize`, { headers: otherH, data: { tenantId: 'sneaky', [opts.overrideField]: opts.valueA } });
  expect(forbidden.status()).toBe(403);
  await ctx.close();

  // Revert.
  const del = await page.request.delete(`${origin}/api/admin/${opts.base}/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/${opts.base}/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string } };
  expect(reverted.provenance.kind).toBe('global');
  const del2 = await page.request.delete(`${origin}/api/admin/${opts.base}/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del2.status()).toBe(404);
}

test('Realm — per-tenant prompt-strategy customize (effective set, provenance, COW, RBAC, revert)', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  await runCatalogRealmFlow(page, browser, { base: 'prompt-strategies', listKey: 'strategies', overrideField: 'instruction_prefix', valueA: 'ACME PREFIX', valueB: 'ACME PREFIX v2' });
});

test('Realm — per-tenant prompt-framework customize (effective set, provenance, COW, RBAC, revert)', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  await runCatalogRealmFlow(page, browser, { base: 'prompt-frameworks', listKey: 'frameworks', overrideField: 'section_separator', valueA: '\n===\n', valueB: '\n---\n' });
});
