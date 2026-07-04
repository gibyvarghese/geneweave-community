/**
 * Playwright E2E — per-tenant Appearance / branding (white-label). Proves the acceptance bar — a
 * workspace admin can safely re-brand geneWeave, the brand is served to the client, and accessibility +
 * tenant isolation are enforced:
 *   • Admin round-trip: PUT colour-scheme / variant / corner / brand accent → GET returns them.
 *   • Validation + security: a non-hex accent is ignored; a logo with <script> is stripped.
 *   • Accessibility: a brand accent that fails WCAG-AA is dropped (degraded) — never shipped.
 *   • RBAC: a non-admin cannot change appearance (403).
 *   • /api/me/appearance returns the caller's resolved brand (the shape the web client applies).
 *   • UI: applying a dark scheme + brand accent re-brands the running app (screenshot).
 * Run: npm run test:e2e -- tenant-appearance  (no LLM required).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wnapp-owner@weaveintel.dev';
const OTHER = 'wnapp-other@weaveintel.dev';
const TENANT = 'acme-appearance';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
const put = (page: Page, origin: string, hdr: Record<string, string>, tenant: string, data: Record<string, unknown>) =>
  page.request.put(`${origin}/api/admin/tenant-appearance/${tenant}`, { headers: hdr, data });

// ── Admin round-trip + validation + security + accessibility (deterministic) ──────────
test('Appearance — admin round-trip, validation, security, accessibility-degrade', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // Valid re-brand round-trips.
  const r = await (await put(page, origin, hdr, TENANT, { brand_name: 'Acme Notes', color_scheme: 'dark', variant: 'creative', corner_style: 'sharp', accent: '#1D4ED8', density: 'compact' })).json() as { tenants: Record<string, unknown>; appearance: { colorScheme: string; variant: string; cornerStyle: string; vars: { light: Record<string, string> } } };
  expect(r.tenants['color_scheme']).toBe('dark');
  expect(r.tenants['variant']).toBe('creative');
  expect(r.tenants['corner_style']).toBe('sharp');
  expect(r.tenants['brand_name']).toBe('Acme Notes');
  // The brand accent maps to the legacy --accent the shipped stylesheet consumes (light theme here).
  expect(r.appearance.vars.light['--accent']).toBe('#1D4ED8');

  const got = await (await page.request.get(`${origin}/api/admin/tenant-appearance/${TENANT}`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['variant']).toBe('creative');
  expect(got.tenants['corner_style']).toBe('sharp');

  // VALIDATION: a non-hex accent is ignored (kept previous).
  const badHex = await (await put(page, origin, hdr, TENANT, { accent: 'blueish' })).json() as { warnings: string[]; appearance: { vars: { light: Record<string, string> } } };
  expect(badHex.warnings.join(' ')).toMatch(/hex/i);
  expect(badHex.appearance.vars.light['--accent']).toBe('#1D4ED8'); // unchanged

  // SECURITY: a logo containing a <script> / handler is stripped.
  const badLogo = await (await put(page, origin, hdr, TENANT, { logo_svg: '<svg onload="alert(1)"><script>steal()</script></svg>' })).json() as { warnings: string[] };
  expect(badLogo.warnings.join(' ')).toMatch(/logo/i); // rejected (scripts/handlers stripped)

  // ACCESSIBILITY: a near-white accent fails contrast → dropped (degraded), never applied.
  const bad = await (await put(page, origin, hdr, TENANT, { accent: '#FEFEFE' })).json() as { appearance: { degraded: boolean; vars: { light: Record<string, string> } }; warnings: string[] };
  expect(bad.appearance.degraded).toBe(true);
  expect(bad.appearance.vars.light['--accent']).toBeUndefined(); // fell back to the accessible default
  expect(bad.warnings.join(' ')).toMatch(/accessib|contrast/i);

  // Reset.
  await put(page, origin, hdr, TENANT, { color_scheme: 'system', variant: 'pro', corner_style: 'soft', accent: '', density: 'comfortable', brand_name: '' });
});

// ── RBAC: a non-admin cannot change appearance ────────────────────────────────────────
test('Appearance — a non-admin cannot re-brand the workspace (403)', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page, OWNER); // ensure the tenant exists
  const origin = new URL(page.url()).origin;
  const ctx = await browser.newContext(); const other = await ctx.newPage(); await login(other, OTHER);
  const res = await other.request.put(`${origin}/api/admin/tenant-appearance/${TENANT}`, { headers: { 'x-csrf-token': await csrf(other) }, data: { color_scheme: 'dark' } });
  expect([401, 403]).toContain(res.status());
  await ctx.close();
});

// ── /api/me/appearance returns the caller's resolved brand (client-apply shape) ───────
test('Appearance — /api/me/appearance returns the caller’s resolved brand', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const a = await (await page.request.get(`${origin}/api/me/appearance`)).json() as { colorScheme: string; variant: string; density: string; vars: { light: Record<string, string>; dark: Record<string, string> } };
  expect(['system', 'light', 'dark']).toContain(a.colorScheme);
  expect(['pro', 'creative']).toContain(a.variant);
  expect(a.vars).toHaveProperty('light');
  expect(a.vars).toHaveProperty('dark');
});

// ── UI: applying a brand re-brands the running app ────────────────────────────────────
test('Appearance — UI: a dark brand + accent re-brands the running app', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1320, height: 900 });
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  // Default light shell first (baseline screenshot).
  await page.request.put(`${origin}/api/admin/tenant-appearance/default`, { headers: hdr, data: { color_scheme: 'light', variant: 'pro', accent: '', density: 'comfortable' } });
  await page.reload(); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: 'test-results/appearance-default.png' });
  const beforeTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  // Re-brand 1 — dark colour scheme. Applied before first render (data-theme=dark).
  await page.request.put(`${origin}/api/admin/tenant-appearance/default`, { headers: hdr, data: { color_scheme: 'dark', variant: 'pro', accent: '' } });
  await page.reload(); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await page.screenshot({ path: 'test-results/appearance-dark.png' });

  // Re-brand 2 — light + a blue brand accent (which passes AA on the light canvas → --accent overridden).
  await page.request.put(`${origin}/api/admin/tenant-appearance/default`, { headers: hdr, data: { color_scheme: 'light', variant: 'pro', accent: '#1D4ED8' } });
  await page.reload(); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }));
  // eslint-disable-next-line no-console
  console.log(`[appearance] before=${beforeTheme} dark→light+accent=${JSON.stringify(applied)}`);
  expect(applied.theme).toBe('light');
  expect(applied.accent.toLowerCase()).toBe('#1d4ed8'); // brand accent applied (AA-passing on light)
  await page.screenshot({ path: 'test-results/appearance-branded.png' });

  // Reset so other runs start clean.
  await page.request.put(`${origin}/api/admin/tenant-appearance/default`, { headers: hdr, data: { color_scheme: 'system', accent: '' } });
});
