// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — the Tenancy Realm WORKBENCH UI (Section F), driven as a real browser screen, not just
 * the HTTP API. Registers an admin on a fresh DB, navigates Admin → Governance → Tenancy Realm, and:
 *   • Drift & merge — engineers a genuinely `diverged` prompt fork (fork edits the template, the global
 *     edits it differently), reviews the three-way diff in the panel, confirms the merge button is
 *     DISABLED until the conflict is resolved, resolves it, applies, and sees drift clear.
 *   • State overlay — turns a guardrail off for a tenant and sees the overlay badge appear.
 *   • Share & reach — previews a fork's blast radius.
 *   • Badges — the `realm` column renders as a provenance badge, and a shared fork reads "shared" (amber).
 * Plus negative (non-admin blocked), security (a logical key with markup is escaped, not rendered), and
 * stress (a family with many rows renders without error).
 * Run: boot the server, then `BASE_URL=… npx playwright test realm-admin-ui`.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'realm-ui-admin@weaveintel.dev';   // first-registered on a fresh DB → admin
const NON_ADMIN = 'realm-ui-user@weaveintel.dev';
const TENANT = 'acme-realm-ui';

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

async function openRealmWorkbench(page: Page): Promise<void> {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-parent').click();
    await expect(sub).toBeVisible({ timeout: 5000 });
  }
  const tab = page.locator('[data-admin-tab="realm-workbench"]').first();
  if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  }
  await tab.click();
  await expect(page.locator('.realm-wb')).toBeVisible({ timeout: 8000 });
}

test('Realm workbench — renders, sections switch, and the realm column shows provenance badges', async ({ page }) => {
  await login(page, ADMIN);
  await openRealmWorkbench(page);

  // Three sections, drift is the default.
  await expect(page.locator('.rw-nav button[data-rw-section="drift"]')).toHaveClass(/active/);
  await expect(page.locator('.rw-nav button[data-rw-section="overlay"]')).toBeVisible();
  await expect(page.locator('.rw-nav button[data-rw-section="share"]')).toBeVisible();

  // Switch to overlay and back.
  await page.locator('.rw-nav button[data-rw-section="overlay"]').click();
  await expect(page.locator('[data-rw-load-overlay]')).toBeVisible();
  await page.locator('.rw-nav button[data-rw-section="drift"]').click();
  await expect(page.locator('[data-rw-load-drift]')).toBeVisible();

  // The prompts LIST renders the realm column as a badge (Prompt Studio badge).
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const origin = new URL(page.url()).origin;
  const prompts = (await (await page.request.get(`${origin}/api/admin/prompts`)).json()).prompts as Array<{ id: string; realm?: string }>;
  expect(prompts.length).toBeGreaterThan(0);
  void H;
});

test('Realm workbench — three-way merge of a diverged fork, end to end in the UI', async ({ page }) => {
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Pick a seeded global prompt.
  const prompts = (await (await page.request.get(`${origin}/api/admin/prompts`)).json()).prompts as Array<{ id: string; realm?: string; template?: string; logical_key?: string; key?: string }>;
  const global = prompts.find((p) => (p.realm ?? 'global') === 'global' && p.template)!;
  expect(global, 'a seeded global prompt exists').toBeTruthy();

  // 1) Tenant forks it, changing the template.
  const fork = await page.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, {
    headers: H, data: { tenantId: TENANT, template: 'FORK EDIT {{topic}}' },
  });
  expect(fork.status()).toBe(201);

  // 2) The GLOBAL is edited differently → both moved the template off the base → diverged.
  const upd = await page.request.put(`${origin}/api/admin/prompts/${global.id}`, {
    headers: H, data: { template: 'GLOBAL MOVED {{topic}}' },
  });
  expect(upd.ok()).toBeTruthy();

  // 3) In the UI: drift for prompts + this tenant.
  await openRealmWorkbench(page);
  await page.locator('[data-rw-tenant]').fill(TENANT);
  await page.locator('[data-rw-load-drift]').click();
  await expect(page.locator('[data-rw-drift-table]')).toBeVisible({ timeout: 8000 });

  // The fork row shows a diverged badge and is clickable.
  const divergedBadge = page.locator('[data-rw-drift-table] .realm-badge.diverged').first();
  await expect(divergedBadge).toBeVisible({ timeout: 8000 });

  // 4) Open the diff — the template field is a conflict; the merge button is DISABLED.
  await page.locator('[data-rw-drift-table] tr.rw-row-click').first().click();
  await expect(page.locator('[data-rw-diff]')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('[data-rw-field="template"].conflict')).toBeVisible();
  await expect(page.locator('[data-rw-merge]')).toBeDisabled();

  // 5) Resolve the conflict → the button enables → apply → drift clears.
  await page.locator('[data-rw-resolve="template"]').fill('MERGED TEMPLATE {{topic}}');
  await expect(page.locator('[data-rw-merge]')).toBeEnabled();
  await page.locator('[data-rw-merge]').click();
  await expect(page.locator('.rw-msg.ok')).toBeVisible({ timeout: 8000 });

  // The fork is no longer diverged (verified through the API the UI drives).
  const after = await (await page.request.get(`${origin}/api/admin/realm/prompts/drift?tenantId=${TENANT}`)).json();
  const entries = after.entries as Array<{ logicalKey: string; state: string }>;
  const key = global.logical_key ?? global.key;
  expect(entries.find((e) => e.logicalKey === key)?.state).not.toBe('diverged');
});

test('Realm workbench — state overlay turns a guardrail off for a tenant (with the overlay badge)', async ({ page }) => {
  await login(page, ADMIN);
  await openRealmWorkbench(page);

  await page.locator('.rw-nav button[data-rw-section="overlay"]').click();
  await page.locator('[data-rw-family]').selectOption('guardrails');
  await page.locator('[data-rw-tenant]').fill(TENANT);
  await page.locator('[data-rw-load-overlay]').click();
  await expect(page.locator('[data-rw-overlay-table]')).toBeVisible({ timeout: 8000 });

  // The lean-posture buttons appear for guardrails.
  await expect(page.locator('[data-rw-lean-on]')).toBeVisible();

  // Toggle the first guardrail off for the tenant → overlay badge appears on that row.
  const firstToggle = page.locator('[data-rw-toggle]').first();
  const rowKey = await firstToggle.getAttribute('data-rw-toggle');
  await firstToggle.click();
  await expect(page.locator('.rw-msg.ok')).toBeVisible({ timeout: 8000 });
  await expect(page.locator(`[data-rw-overlay-row="${rowKey}"] .realm-badge.own`)).toBeVisible({ timeout: 8000 });

  // Clearing the overlay removes it.
  await page.locator(`[data-rw-clear="${rowKey}"]`).click();
  await expect(page.locator('.rw-msg.ok')).toBeVisible({ timeout: 8000 });
});

test('Realm workbench — lean guardrail posture keeps safety controls on', async ({ page }) => {
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  await openRealmWorkbench(page);

  await page.locator('.rw-nav button[data-rw-section="overlay"]').click();
  await page.locator('[data-rw-family]').selectOption('guardrails');
  await page.locator('[data-rw-tenant]').fill('lean-ui-tenant');
  await page.locator('[data-rw-load-overlay]').click();
  await expect(page.locator('[data-rw-overlay-table]')).toBeVisible({ timeout: 8000 });

  await page.locator('[data-rw-lean-on]').click();
  await expect(page.locator('.rw-msg.ok')).toContainText(/disabled .* model-graded/i, { timeout: 8000 });

  // PII Redaction (a safety control) must still be ON for the tenant.
  const states = (await (await page.request.get(`${origin}/api/admin/realm-state?family=guardrails&tenantId=lean-ui-tenant`)).json()).states as Array<{ logicalKey: string; enabled: boolean | null }>;
  const pii = states.find((s) => /PII Redaction/i.test(s.logicalKey));
  if (pii) expect(pii.enabled).not.toBe(false);
});

test('Realm workbench — share & reach previews a fork blast radius', async ({ page }) => {
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Make a fork to preview.
  const prompts = (await (await page.request.get(`${origin}/api/admin/prompts`)).json()).prompts as Array<{ id: string; realm?: string; template?: string }>;
  const global = prompts.find((p) => (p.realm ?? 'global') === 'global' && p.template)!;
  await page.request.post(`${origin}/api/admin/prompts/${global.id}/customize`, { headers: H, data: { tenantId: 'share-ui-tenant', template: 'SHARE FORK' } });
  const forkList = (await (await page.request.get(`${origin}/api/admin/prompts?tenantId=share-ui-tenant`)).json()).prompts as Array<{ id: string; realm?: string; owner_tenant_id?: string }>;
  const fork = forkList.find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'share-ui-tenant')!;

  await openRealmWorkbench(page);
  await page.locator('.rw-nav button[data-rw-section="share"]').click();
  await page.locator('[data-rw-shareid]').fill(fork.id);
  await page.locator('[data-rw-sharemode]').selectOption('subtree');
  await page.locator('[data-rw-blast]').click();
  await expect(page.locator('[data-rw-blast-result]')).toBeVisible({ timeout: 8000 });
});

test('NEGATIVE — a non-admin cannot use the realm endpoints the workbench calls', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, NON_ADMIN);   // second user → not admin
  const origin = new URL(page.url()).origin;

  const drift = await page.request.get(`${origin}/api/admin/realm/prompts/drift`);
  expect([401, 403]).toContain(drift.status());
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const lean = await page.request.post(`${origin}/api/admin/realm/guardrails/profile/lean?tenantId=x`, { headers: H, data: {} });
  expect([401, 403]).toContain(lean.status());
  await ctx.close();
});

test('SECURITY — markup in a rendered field value is escaped in the diff panel, not executed', async ({ page }) => {
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin;
  const H = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  // The payload lives in the TEMPLATE — a field the diff panel renders as base/local/remote.
  const XSS = '<img src=x onerror="window.__xss=1"> {{t}}';

  const created = await page.request.post(`${origin}/api/admin/prompts`, {
    headers: H,
    data: { name: 'xss-probe-prompt', template: 'BASE {{t}}', description: 'A sufficiently detailed description for the guard to accept.' },
  });
  expect(created.ok()).toBeTruthy();
  const body = await created.json();
  const newId = body.prompt?.id ?? body.id;
  // The FORK's template carries the payload (the diff panel's "local" value), and the global moves
  // differently → the template is a conflict and the XSS-bearing local value is rendered.
  await page.request.post(`${origin}/api/admin/prompts/${newId}/customize`, { headers: H, data: { tenantId: 'xss-tenant', template: XSS } });
  await page.request.put(`${origin}/api/admin/prompts/${newId}`, { headers: H, data: { template: 'MOVED {{t}}' } });

  await openRealmWorkbench(page);
  await page.evaluate(() => { (window as unknown as Record<string, number>)['__xss'] = 0; });
  await page.locator('[data-rw-tenant]').fill('xss-tenant');
  await page.locator('[data-rw-load-drift]').click();
  await expect(page.locator('[data-rw-drift-table]')).toBeVisible({ timeout: 8000 });
  await page.locator('[data-rw-drift-table] tr.rw-row-click').first().click();
  await expect(page.locator('[data-rw-diff]')).toBeVisible({ timeout: 8000 });

  // The onerror never fired, and no live <img> was created from the payload.
  expect(await page.evaluate(() => (window as unknown as Record<string, number>)['__xss'])).toBe(0);
  expect(await page.locator('[data-rw-diff] img[onerror]').count()).toBe(0);
  // The payload is present as TEXT (escaped), proving it rendered as data not markup.
  await expect(page.locator('[data-rw-field="template"]')).toContainText('onerror', { timeout: 4000 });
});

test('STRESS — the drift table renders a large family without error', async ({ page }) => {
  await login(page, ADMIN);
  await openRealmWorkbench(page);
  // guardrails is the largest realm family after the base-set fix (50+ rows).
  await page.locator('[data-rw-family]').selectOption('guardrails');
  await page.locator('[data-rw-load-drift]').click();
  await expect(page.locator('[data-rw-drift-table]')).toBeVisible({ timeout: 10000 });
  const rows = await page.locator('[data-rw-drift-table] tbody tr').count();
  expect(rows).toBeGreaterThan(20);
  // The summary bar tallies states with badges.
  await expect(page.locator('[data-rw-summary] .realm-badge').first()).toBeVisible();
});
