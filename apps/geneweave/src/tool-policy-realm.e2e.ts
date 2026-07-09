// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant TOOL POLICY customization over the real admin HTTP API.
 *
 * The acceptance bar: an operator can give one tenant its own copy of a built-in tool policy (e.g. a
 * stricter approval gate / lower rate limit) without touching anyone else's, see who-gets-what
 * (provenance), replace it, and revert it — while UNIQUE(key) stays intact and the effective set
 * presents the policy under its canonical key.
 *   • Customize: POST a fork for tenant A → 201, realm='tenant', owner = A, key = key#A.
 *   • Effective set: GET .../tool-policies?tenantId=A returns the fork under the CANONICAL key;
 *     a different tenant keeps the global.
 *   • Provenance: GET .../:id/realm?tenantId=A → own_override; a different tenant → global.
 *   • Copy-on-write: customizing again replaces the fork (one per tenant), never duplicates.
 *   • RBAC: a non-admin user is refused (403).
 *   • Revert: DELETE the fork → the tenant falls back to the global default.
 * Run: npm run test:e2e -- tool-policy-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'toolpolicy-realm-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'toolpolicy-realm-user@weaveintel.dev';
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

test('Realm — per-tenant tool-policy customize, effective set, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);

  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Pick a seeded GLOBAL policy to customize (the 'default' policy is always seeded).
  const list = await (await page.request.get(`${origin}/api/admin/tool-policies`)).json() as { policies: Array<{ id: string; realm?: string; logical_key?: string; key: string; max_execution_ms?: number | null }> };
  const global = list.policies.find((p) => (p.key ?? '') === 'default') ?? list.policies.find((p) => (p.realm ?? 'global') === 'global') ?? list.policies[0];
  expect(global, 'a seeded global policy exists').toBeTruthy();
  if (!global) throw new Error('no seeded policy');
  const canonicalKey = global.logical_key ?? global.key;

  // ── Customize for tenant A ──────────────────────────────────────────────────────────
  const created = await page.request.post(`${origin}/api/admin/tool-policies/${global.id}/customize`, {
    headers: H,
    data: { tenantId: TENANT_A, approval_required: true, max_execution_ms: 12345, rate_limit_per_minute: 5 },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; key: string; logical_key: string; approval_required: number; max_execution_ms: number }; replacedExisting: boolean };
  expect(createdBody.fork.realm).toBe('tenant');
  expect(createdBody.fork.owner_tenant_id).toBe(TENANT_A);
  expect(createdBody.fork.origin_id).toBe(global.id);
  expect(createdBody.fork.content_hash).toMatch(/^sha256:/);
  expect(createdBody.fork.logical_key).toBe(canonicalKey);
  expect(createdBody.fork.key).toBe(`${canonicalKey}#${TENANT_A}`); // tenant-scoped, satisfies UNIQUE(key)
  expect(createdBody.fork.approval_required).toBe(1);
  expect(createdBody.fork.max_execution_ms).toBe(12345);
  expect(createdBody.replacedExisting).toBe(false);

  // ── Effective set: tenant A sees the fork under the CANONICAL key; tenant B keeps the global ──
  const setA = await (await page.request.get(`${origin}/api/admin/tool-policies?tenantId=${TENANT_A}`)).json() as { policies: Array<{ key: string; logical_key?: string; max_execution_ms?: number | null; realm?: string }> };
  const aP = setA.policies.find((p) => (p.logical_key ?? p.key) === canonicalKey)!;
  expect(aP.key).toBe(canonicalKey);          // canonical key restored on the effective row
  expect(aP.max_execution_ms).toBe(12345);
  const dupes = setA.policies.filter((p) => (p.logical_key ?? p.key) === canonicalKey);
  expect(dupes.length).toBe(1);               // one policy per canonical key (no global + fork dupes)

  const setB = await (await page.request.get(`${origin}/api/admin/tool-policies?tenantId=${TENANT_B}`)).json() as { policies: Array<{ key: string; logical_key?: string; max_execution_ms?: number | null }> };
  const bP = setB.policies.find((p) => (p.logical_key ?? p.key) === canonicalKey)!;
  expect(bP.max_execution_ms).not.toBe(12345);

  // ── Provenance ──────────────────────────────────────────────────────────────────────
  const provA = await (await page.request.get(`${origin}/api/admin/tool-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { max_execution_ms: number; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.max_execution_ms).toBe(12345);
  expect(provA.effective.owner_tenant_id).toBe(TENANT_A);

  const provB = await (await page.request.get(`${origin}/api/admin/tool-policies/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { effective: { max_execution_ms: number | null }; provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');
  expect(provB.effective.max_execution_ms).not.toBe(12345);

  // ── Copy-on-write: customizing again REPLACES the fork (one per tenant) ──────────────
  const replaced = await page.request.post(`${origin}/api/admin/tool-policies/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, max_execution_ms: 999 },
  });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const afterReplace = await (await page.request.get(`${origin}/api/admin/tool-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { max_execution_ms: number } };
  expect(afterReplace.effective.max_execution_ms).toBe(999);

  // A tenant copy cannot itself be customized (must fork the global).
  const forkId = (await (await page.request.get(`${origin}/api/admin/tool-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  const nested = await page.request.post(`${origin}/api/admin/tool-policies/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, max_execution_ms: 1 } });
  expect(nested.status()).toBe(400);

  // ── RBAC: a non-admin user is refused ───────────────────────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  const forbidden = await otherPage.request.post(`${origin}/api/admin/tool-policies/${global.id}/customize`, {
    headers: otherH, data: { tenantId: 'sneaky', max_execution_ms: 1 },
  });
  expect(forbidden.status()).toBe(403);
  await ctx.close();

  // ── Revert: DELETE the fork → tenant A falls back to the global ──────────────────────
  const del = await page.request.delete(`${origin}/api/admin/tool-policies/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/tool-policies/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string }; effective: { max_execution_ms: number | null } };
  expect(reverted.provenance.kind).toBe('global');
  expect(reverted.effective.max_execution_ms).not.toBe(999);

  // A second revert is a clean 404 (nothing to revert).
  const del2 = await page.request.delete(`${origin}/api/admin/tool-policies/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del2.status()).toBe(404);
});
