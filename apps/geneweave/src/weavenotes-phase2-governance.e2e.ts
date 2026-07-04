/**
 * Playwright E2E — weaveNotes Phase 2 (per-tenant enterprise GOVERNANCE). Proves, against a live
 * server:
 *   • An admin sets a tenant's posture (residency, no-training, enforced SSO+protocol, SCIM, retention,
 *     legal hold) and reads back the compliance CHECKLIST, which reflects both the policy AND the
 *     tenant's encryption/BYOK state (surfaced from the encryption tables).
 *   • Validation: unknown enums are rejected (warning), retention clamps, SSO-required defaults a
 *     protocol.
 *   • SECURITY: a non-admin user cannot read or write tenant governance (admin-only), but CAN read
 *     their own workspace's posture via /api/me/governance (read-only).
 * Run: npm run test:e2e -- weavenotes-phase2-governance   (no LLM needed)
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN = 'wn2gov-admin@weaveintel.dev';   // first-registered on a fresh DB → platform_admin
const USER = 'wn2gov-user@weaveintel.dev';
const TENANT = 'globex-enterprise';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }

interface Posture { key: string; status: string; detail: string }
interface Effective { governance: { dataResidency: string; allowModelTraining: boolean; ssoRequired: boolean; ssoProtocol: string; legalHold: boolean; activityRetentionDays: number }; posture: Posture[]; score: { on: number; total: number }; configured: boolean }

test('Phase 2 governance — admin sets posture → checklist reflects it; validated; admin-only; user can read', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // Set an enterprise posture for the tenant.
  const put = await page.request.put(`${origin}/api/admin/tenant-governance/${TENANT}`, { headers: hdr, data: {
    data_residency: 'eu', allow_model_training: false, allow_analytics: false,
    sso_required: true, sso_protocol: 'oidc', scim_enabled: true,
    activity_retention_days: 30, audit_retention_days: 365, legal_hold: true,
  } });
  expect(put.status()).toBe(200);
  const putBody = await put.json() as { governance: Effective; warnings: string[] };
  const g = putBody.governance.governance;
  expect(g.dataResidency).toBe('eu');
  expect(g.allowModelTraining).toBe(false);
  expect(g.ssoRequired).toBe(true);
  expect(g.ssoProtocol).toBe('oidc');
  expect(g.legalHold).toBe(true);

  // The checklist reflects the policy.
  const by = Object.fromEntries(putBody.governance.posture.map((p) => [p.key, p]));
  expect(by['data_residency']!.status).toBe('on');
  expect(by['data_residency']!.detail).toMatch(/EU/);
  expect(by['no_training']!.status).toBe('on');           // training OFF → control ON
  expect(by['sso']!.status).toBe('on');
  expect(by['sso']!.detail).toMatch(/OIDC/);
  expect(by['scim']!.status).toBe('on');
  expect(by['legal_hold']!.status).toBe('on');
  expect(by['activity_retention']!.detail).toMatch(/30 days/);
  expect(putBody.governance.score.on).toBeGreaterThanOrEqual(5);
  expect(putBody.governance.score.total).toBe(10);

  // List + single GET both show the tenant.
  const list = await (await page.request.get(`${origin}/api/admin/tenant-governance`)).json() as { tenants: Array<{ tenant_id: string; controls: string }> };
  expect(list.tenants.some((t) => t.tenant_id === TENANT)).toBe(true);
  const one = await (await page.request.get(`${origin}/api/admin/tenant-governance/${TENANT}`)).json() as { governance: Effective; tenants: { tenant_id: string; data_residency: string } };
  expect(one.governance.governance.dataResidency).toBe('eu');
  expect(one.tenants.data_residency).toBe('eu');

  // VALIDATION: unknown residency rejected (warning, value unchanged); retention clamps.
  const bad = await (await page.request.put(`${origin}/api/admin/tenant-governance/${TENANT}`, { headers: hdr, data: { data_residency: 'mars', activity_retention_days: 999999 } })).json() as { governance: Effective; warnings: string[] };
  expect(bad.governance.governance.dataResidency).toBe('eu'); // unchanged
  expect(bad.governance.governance.activityRetentionDays).toBe(3650); // clamped
  expect(bad.warnings.length).toBeGreaterThanOrEqual(1);

  // SECURITY: a non-admin user cannot read or write tenant governance.
  const other = await page.context().browser()!.newContext(); const up = await other.newPage(); await login(up, USER);
  const uOrigin = new URL(up.url()).origin; const uHdr = { 'x-csrf-token': await csrf(up) };
  expect((await up.request.get(`${uOrigin}/api/admin/tenant-governance`)).status()).toBe(403);
  expect((await up.request.put(`${uOrigin}/api/admin/tenant-governance/${TENANT}`, { headers: uHdr, data: { legal_hold: false } })).status()).toBe(403);

  // …but the user CAN read their OWN workspace's posture (read-only), returning a full checklist.
  const mine = await up.request.get(`${uOrigin}/api/me/governance`);
  expect(mine.status()).toBe(200);
  const minePosture = await mine.json() as Effective;
  expect(Array.isArray(minePosture.posture)).toBe(true);
  expect(minePosture.posture.length).toBe(10);
  expect(minePosture.score.total).toBe(10);
  await other.close();

  // DELETE reverts to defaults.
  expect((await page.request.delete(`${origin}/api/admin/tenant-governance/${TENANT}`, { headers: hdr })).status()).toBe(200);
  const afterDel = await (await page.request.get(`${origin}/api/admin/tenant-governance/${TENANT}`)).json() as { governance: Effective };
  expect(afterDel.governance.configured).toBe(false);          // no explicit row → defaults
  expect(afterDel.governance.governance.dataResidency).toBe('unrestricted');
});

// ── UI: the read-only Workspace Governance checklist card ───────────────────────
test('Phase 2 governance — UI: Insert → 🛡️ Workspace governance renders the checklist', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Governance UI note', doc_json: { type: 'doc', content: [] } } })).json();

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Governance UI note', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);

  await page.getByRole('button', { name: /Insert/ }).first().click();
  await page.getByText('🛡️ Workspace governance', { exact: false }).first().click();
  await expect(page.locator('.gw-gov')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.gw-gov-item')).toHaveCount(10);    // the full checklist
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad/gw-wn2-governance.png' });
});
