// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant GUARDRAIL customization over the real admin HTTP API.
 *
 * The acceptance bar: an operator can give one tenant its own copy of a built-in guardrail (e.g. a
 * stricter config) without touching anyone else's, see who-gets-what (provenance), replace it, and
 * revert it — and a non-admin can't.
 *   • Customize: POST a fork for tenant A → 201, realm='tenant', owner = A.
 *   • Effective set: GET .../guardrails?tenantId=A returns the fork; a different tenant keeps the global.
 *   • Provenance: GET .../:id/realm?tenantId=A → own_override; a different tenant → global.
 *   • Copy-on-write: customizing again replaces the fork (one per tenant), never duplicates.
 *   • RBAC: a non-admin user is refused (403).
 *   • Revert: DELETE the fork → the tenant falls back to the global default.
 * Run: npm run test:e2e -- guardrail-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'guardrail-realm-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'guardrail-realm-user@weaveintel.dev';
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

test('Realm — per-tenant guardrail customize, effective set, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);

  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Pick a seeded GLOBAL guardrail to customize.
  const list = await (await page.request.get(`${origin}/api/admin/guardrails`)).json() as { guardrails: Array<{ id: string; realm?: string; logical_key?: string; name: string; config?: string }> };
  const global = list.guardrails.find((g) => (g.realm ?? 'global') === 'global') ?? list.guardrails[0];
  expect(global, 'a seeded global guardrail exists').toBeTruthy();
  if (!global) throw new Error('no seeded guardrail');
  const canonicalName = global.logical_key ?? global.name;

  // ── Customize for tenant A ──────────────────────────────────────────────────────────
  const created = await page.request.post(`${origin}/api/admin/guardrails/${global.id}/customize`, {
    headers: H,
    data: { tenantId: TENANT_A, config: { tenantMarker: 'ACME_STRICT', threshold: 0.95 } },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; name: string; logical_key: string; config: string }; replacedExisting: boolean };
  expect(createdBody.fork.realm).toBe('tenant');
  expect(createdBody.fork.owner_tenant_id).toBe(TENANT_A);
  expect(createdBody.fork.origin_id).toBe(global.id);
  expect(createdBody.fork.content_hash).toMatch(/^sha256:/);
  expect(createdBody.fork.logical_key).toBe(canonicalName);
  expect(createdBody.fork.name).toBe(canonicalName); // no UNIQUE(name) → fork keeps the same name
  expect(createdBody.fork.config).toContain('ACME_STRICT');
  expect(createdBody.replacedExisting).toBe(false);

  // ── Effective set: tenant A sees the fork; tenant B keeps the global ─────────────────
  const setA = await (await page.request.get(`${origin}/api/admin/guardrails?tenantId=${TENANT_A}`)).json() as { guardrails: Array<{ name: string; logical_key?: string; config?: string; realm?: string }> };
  const aG = setA.guardrails.find((g) => (g.logical_key ?? g.name) === canonicalName)!;
  expect(aG.config ?? '').toContain('ACME_STRICT');
  // Exactly one guardrail per canonical key in the effective set (no duplicate global + fork).
  const dupes = setA.guardrails.filter((g) => (g.logical_key ?? g.name) === canonicalName);
  expect(dupes.length).toBe(1);

  const setB = await (await page.request.get(`${origin}/api/admin/guardrails?tenantId=${TENANT_B}`)).json() as { guardrails: Array<{ name: string; logical_key?: string; config?: string }> };
  const bG = setB.guardrails.find((g) => (g.logical_key ?? g.name) === canonicalName)!;
  expect(bG.config ?? '').not.toContain('ACME_STRICT');

  // ── Provenance ──────────────────────────────────────────────────────────────────────
  const provA = await (await page.request.get(`${origin}/api/admin/guardrails/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { config: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.config).toContain('ACME_STRICT');
  expect(provA.effective.owner_tenant_id).toBe(TENANT_A);

  const provB = await (await page.request.get(`${origin}/api/admin/guardrails/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { effective: { config: string }; provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');
  expect(provB.effective.config ?? '').not.toContain('ACME_STRICT');

  // ── Copy-on-write: customizing again REPLACES the fork (one per tenant) ──────────────
  const replaced = await page.request.post(`${origin}/api/admin/guardrails/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, config: { tenantMarker: 'ACME_V2' } },
  });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const afterReplace = await (await page.request.get(`${origin}/api/admin/guardrails/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { config: string } };
  expect(afterReplace.effective.config).toContain('ACME_V2');

  // A tenant copy cannot itself be customized (must fork the global).
  const forkId = (await (await page.request.get(`${origin}/api/admin/guardrails/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  const nested = await page.request.post(`${origin}/api/admin/guardrails/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, config: {} } });
  expect(nested.status()).toBe(400);

  // ── RBAC: a non-admin user is refused ───────────────────────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  const forbidden = await otherPage.request.post(`${origin}/api/admin/guardrails/${global.id}/customize`, {
    headers: otherH, data: { tenantId: 'sneaky', config: {} },
  });
  expect(forbidden.status()).toBe(403);
  await ctx.close();

  // ── Revert: DELETE the fork → tenant A falls back to the global ──────────────────────
  const del = await page.request.delete(`${origin}/api/admin/guardrails/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/guardrails/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string }; effective: { config: string } };
  expect(reverted.provenance.kind).toBe('global');
  expect(reverted.effective.config ?? '').not.toContain('ACME_V2');

  // A second revert is a clean 404 (nothing to revert).
  const del2 = await page.request.delete(`${origin}/api/admin/guardrails/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del2.status()).toBe(404);
});
