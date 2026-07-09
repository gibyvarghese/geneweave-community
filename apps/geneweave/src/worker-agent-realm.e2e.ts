// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Tenancy Realm per-tenant WORKER AGENT customization over the real admin HTTP API.
 *
 * The acceptance bar: an operator can give one tenant its own copy of a built-in worker (e.g. a
 * tenant-specific system_prompt) without touching anyone else's, see who-gets-what (provenance),
 * replace it, and revert it — all while UNIQUE(name) on worker_agents stays intact and every tenant
 * still resolves the worker under its canonical name.
 *   • Customize: POST a fork for tenant A → 201, realm='tenant', owner = A.
 *   • Effective roster: GET .../worker-agents?tenantId=A returns the fork under the CANONICAL name;
 *     a different tenant's roster keeps the global.
 *   • Provenance: GET .../:id/realm?tenantId=A → own_override; a different tenant → global.
 *   • Copy-on-write: customizing again replaces the fork (one per tenant), never duplicates.
 *   • RBAC: a non-admin user is refused (403).
 *   • Revert: DELETE the fork → the tenant falls back to the global default.
 * Run: npm run test:e2e -- worker-agent-realm   (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'worker-realm-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'worker-realm-user@weaveintel.dev';
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

test('Realm — per-tenant worker-agent customize, effective roster, provenance, copy-on-write, RBAC, revert', async ({ page, browser }) => {
  test.setTimeout(90_000);

  // The admin must be the FIRST user on the fresh managed DB to be auto-promoted.
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Pick a seeded GLOBAL worker to customize.
  const list = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents: Array<{ id: string; realm?: string; logical_key?: string; name: string; system_prompt?: string }> };
  const global = list.workerAgents.find((w) => (w.realm ?? 'global') === 'global') ?? list.workerAgents[0];
  expect(global, 'a seeded global worker exists').toBeTruthy();
  if (!global) throw new Error('no seeded worker');
  const canonicalName = global.logical_key ?? global.name;

  // ── Customize for tenant A ──────────────────────────────────────────────────────────
  const created = await page.request.post(`${origin}/api/admin/worker-agents/${global.id}/customize`, {
    headers: H,
    data: { tenantId: TENANT_A, system_prompt: 'You are Acme Clinic’s worker. Cite clinical guidelines and flag PHI.' },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json() as { fork: { realm: string; owner_tenant_id: string; origin_id: string; content_hash: string; name: string; logical_key: string }; replacedExisting: boolean };
  expect(createdBody.fork.realm).toBe('tenant');
  expect(createdBody.fork.owner_tenant_id).toBe(TENANT_A);
  expect(createdBody.fork.origin_id).toBe(global.id);
  expect(createdBody.fork.content_hash).toMatch(/^sha256:/);
  expect(createdBody.fork.logical_key).toBe(canonicalName);
  expect(createdBody.fork.name).toBe(`${canonicalName}#${TENANT_A}`); // tenant-scoped, satisfies UNIQUE(name)
  expect(createdBody.replacedExisting).toBe(false);

  // ── Effective roster: tenant A sees the fork under the CANONICAL name; tenant B keeps the global ──
  const rosterA = await (await page.request.get(`${origin}/api/admin/worker-agents?tenantId=${TENANT_A}`)).json() as { workerAgents: Array<{ name: string; logical_key?: string; system_prompt?: string; realm?: string }> };
  const aWorker = rosterA.workerAgents.find((w) => (w.logical_key ?? w.name) === canonicalName)!;
  expect(aWorker.name).toBe(canonicalName); // canonical name restored on the effective row
  expect(aWorker.system_prompt).toContain('Acme Clinic');
  // Exactly one worker per canonical name in the roster (no duplicate global + fork).
  const dupes = rosterA.workerAgents.filter((w) => (w.logical_key ?? w.name) === canonicalName);
  expect(dupes.length).toBe(1);

  const rosterB = await (await page.request.get(`${origin}/api/admin/worker-agents?tenantId=${TENANT_B}`)).json() as { workerAgents: Array<{ name: string; logical_key?: string; system_prompt?: string }> };
  const bWorker = rosterB.workerAgents.find((w) => (w.logical_key ?? w.name) === canonicalName)!;
  expect(bWorker.system_prompt ?? '').not.toContain('Acme Clinic');

  // ── Provenance ──────────────────────────────────────────────────────────────────────
  const provA = await (await page.request.get(`${origin}/api/admin/worker-agents/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { system_prompt: string; owner_tenant_id: string }; provenance: { kind: string } };
  expect(provA.provenance.kind).toBe('own_override');
  expect(provA.effective.system_prompt).toContain('Acme Clinic');
  expect(provA.effective.owner_tenant_id).toBe(TENANT_A);

  const provB = await (await page.request.get(`${origin}/api/admin/worker-agents/${global.id}/realm?tenantId=${TENANT_B}`)).json() as { effective: { system_prompt: string }; provenance: { kind: string } };
  expect(provB.provenance.kind).toBe('global');
  expect(provB.effective.system_prompt ?? '').not.toContain('Acme Clinic');

  // ── Copy-on-write: customizing again REPLACES the fork (one per tenant) ──────────────
  const replaced = await page.request.post(`${origin}/api/admin/worker-agents/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT_A, system_prompt: 'You are Acme Clinic’s worker — v2.' },
  });
  expect(replaced.status()).toBe(201);
  expect((await replaced.json() as { replacedExisting: boolean }).replacedExisting).toBe(true);
  const afterReplace = await (await page.request.get(`${origin}/api/admin/worker-agents/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { system_prompt: string } };
  expect(afterReplace.effective.system_prompt).toContain('v2');

  // A tenant copy cannot itself be customized (must fork the global).
  const forkId = (await (await page.request.get(`${origin}/api/admin/worker-agents/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { effective: { id: string } }).effective.id;
  const nested = await page.request.post(`${origin}/api/admin/worker-agents/${forkId}/customize`, { headers: H, data: { tenantId: TENANT_B, system_prompt: 'x' } });
  expect(nested.status()).toBe(400);

  // ── RBAC: a non-admin user is refused ───────────────────────────────────────────────
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await login(otherPage, NON_ADMIN);
  const otherH = { 'x-csrf-token': await csrf(otherPage), 'content-type': 'application/json' };
  const forbidden = await otherPage.request.post(`${origin}/api/admin/worker-agents/${global.id}/customize`, {
    headers: otherH, data: { tenantId: 'sneaky', system_prompt: 'nope' },
  });
  expect(forbidden.status()).toBe(403);
  await ctx.close();

  // ── Revert: DELETE the fork → tenant A falls back to the global ──────────────────────
  const del = await page.request.delete(`${origin}/api/admin/worker-agents/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del.status()).toBe(200);
  const reverted = await (await page.request.get(`${origin}/api/admin/worker-agents/${global.id}/realm?tenantId=${TENANT_A}`)).json() as { provenance: { kind: string }; effective: { system_prompt: string } };
  expect(reverted.provenance.kind).toBe('global');
  expect(reverted.effective.system_prompt ?? '').not.toContain('Acme Clinic');

  // A second revert is a clean 404 (nothing to revert).
  const del2 = await page.request.delete(`${origin}/api/admin/worker-agents/${global.id}/customize?tenantId=${TENANT_A}`, { headers: H });
  expect(del2.status()).toBe(404);
});
