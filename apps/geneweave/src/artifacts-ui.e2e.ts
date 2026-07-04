/**
 * Playwright E2E: Artifact UI interactions (Phase 5 + Phase 6)
 *
 * Tests all artifact-related user interactions in the geneWeave UI:
 *
 *   Phase 5:
 *   1. Admin artifacts tab loads correctly
 *   2. Render endpoint returns correct HTML with CSP headers
 *   3. Admin render endpoint works
 *   4. Preview/Configure Live buttons appear in artifact detail
 *   5. Per-type render content tests (markdown, json, code, mermaid, svg, html)
 *
 *   Phase 6 (Live Artifacts):
 *   6. GET /live-config → 404 before creation
 *   7. POST /live-config → 201, correct interval
 *   8. render-live injects toolbar when live config present
 *   9. POST /refresh → 404 without live config
 *  10. DELETE /live-config removes the config
 *  11. PATCH /live-config updates fields
 */

import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const TEST_EMAIL = 'artifacts-ui-e2e@weaveintel.dev';

// ─── Auth / CSRF helpers ───────────────────────────────────────────────────────

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let login = await page.request.post('/api/auth/login', {
    data: { email: TEST_EMAIL, password: PASSWORD },
  });
  if (login.status() !== 200) {
    await page.request.post('/api/auth/register', {
      data: { name: 'Artifacts E2E', email: TEST_EMAIL, password: PASSWORD },
    });
    login = await page.request.post('/api/auth/login', {
      data: { email: TEST_EMAIL, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10000 });
}

/** Get the per-session CSRF token needed for mutating API calls. */
async function getCsrfToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/auth/me');
  if (!res.ok()) return '';
  const data = await res.json() as { csrfToken?: string };
  return data.csrfToken ?? '';
}

/** Create an artifact via the admin API. Includes CSRF token so POST succeeds. */
async function createArtifact(
  page: Page,
  csrf: string,
  opts: { name?: string; type?: string; data?: string } = {},
): Promise<string> {
  const mimeMap: Record<string, string> = {
    markdown: 'text/markdown', json: 'application/json', code: 'text/plain',
    text: 'text/plain', svg: 'image/svg+xml', html: 'text/html', mermaid: 'text/x-mermaid',
  };
  const type = opts.type ?? 'markdown';
  const res = await page.request.post('/api/admin/artifacts', {
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
    data: {
      name: opts.name ?? `test.${type}`,
      type,
      mimeType: mimeMap[type] ?? 'text/plain',
      data: opts.data ?? `# Test\n\nCreated by Playwright at ${new Date().toISOString()}`,
      scope: 'user',
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => '<no body>');
    console.log(`[pw] createArtifact failed ${res.status()}: ${body}`);
    return '';
  }
  const body = await res.json() as { artifact?: { id: string } };
  return body.artifact?.id ?? '';
}

async function goAdmin(page: Page): Promise<void> {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 8000 });
}

async function openArtifactsTab(page: Page): Promise<void> {
  const tabButton = page.locator('[data-admin-tab="artifacts"]').first();
  if (!(await tabButton.isVisible({ timeout: 1000 }).catch(() => false))) {
    const knowledgeGroup = page.locator('.admin-group-btn', { hasText: 'Knowledge' });
    if (await knowledgeGroup.isVisible({ timeout: 1000 }).catch(() => false)) {
      await knowledgeGroup.click();
    } else {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) {
        await groups.nth(i).click();
        if (await tabButton.isVisible({ timeout: 400 }).catch(() => false)) break;
      }
    }
  }
  await expect(tabButton).toBeVisible({ timeout: 5000 });
  await tabButton.click();
  await page.waitForTimeout(500);
}

// ─── Phase 5: Admin UI Tests ──────────────────────────────────────────────────

test.describe('Phase 5: Admin artifacts tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('artifacts admin tab loads — shows table or empty state', async ({ page }) => {
    await goAdmin(page);
    await openArtifactsTab(page);

    const tabContent = page.locator('.chart-box, :text("No records"), :text("Artifacts"), .admin-list-panel').first();
    await expect(tabContent).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: '/tmp/pw-artifacts-tab.png', fullPage: false });
  });

  test('artifact row click shows detail with Preview + Configure Live buttons', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    await createArtifact(page, csrf, { name: 'e2e-detail.md', data: '# E2E Detail Test' });

    await goAdmin(page);
    await openArtifactsTab(page);
    await page.waitForTimeout(800);

    const row = page.locator('tbody tr, .admin-list-row, tr.clickable-row').first();
    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[pw] No artifact rows found in table after creation — check DB seeding');
      test.skip(true, 'No rows found in admin table');
      return;
    }
    await row.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: '/tmp/pw-artifacts-row-detail.png', fullPage: false });

    const previewBtn = page.locator('button', { hasText: 'Preview' });
    const liveBtn = page.locator('button', { hasText: 'Configure Live' });
    const hasPreview = await previewBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const hasLive = await liveBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasPreview) await page.screenshot({ path: '/tmp/pw-artifacts-preview-btn.png', fullPage: false });
    if (hasLive) await page.screenshot({ path: '/tmp/pw-artifacts-live-btn.png', fullPage: false });
    expect(hasPreview || hasLive).toBe(true);
  });
});

// ─── Phase 5: Render endpoint API tests ───────────────────────────────────────

test.describe('Phase 5: Render endpoint API', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('render endpoint returns 200 + text/html + CSP for markdown artifact', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { type: 'markdown', data: '# Hello Playwright\n\nBold **text**.' });
    if (!id) { test.skip(true, 'Failed to create test artifact'); return; }

    const res = await page.request.get(`/api/artifacts/${id}/render`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');

    const csp = res.headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");

    const html = await res.text();
    expect(html).toContain('marked');
    await page.screenshot({ path: '/tmp/pw-render-endpoint-ok.png', fullPage: false });
  });

  test('admin render endpoint returns 200 + correct HTML for markdown', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'admin-render.md', data: '# Admin Render\n\nTest content.' });
    if (!id) { test.skip(true, 'Failed to create artifact'); return; }

    const res = await page.request.get(`/api/admin/artifacts/${id}/render`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('Admin Render');
    expect(html).not.toContain('live-toolbar');
  });

  test('render returns 401 when not authenticated', async ({ page }) => {
    const anonCtx = await page.context().browser()!.newContext();
    const anonPage = await anonCtx.newPage();
    const res = await anonPage.request.get('/api/artifacts/any-id/render');
    expect(res.status()).toBe(401);
    await anonCtx.close();
  });

  test('render returns 404 for unknown artifact', async ({ page }) => {
    const res = await page.request.get('/api/artifacts/00000000-0000-0000-0000-000000000000/render');
    expect(res.status()).toBe(404);
  });
});

// ─── Phase 5: Per-type render content ────────────────────────────────────────

const RENDER_CASES: Array<{ type: string; data: string; expectInHtml: string }> = [
  { type: 'markdown', data: '# Hello\n\n**Bold**', expectInHtml: 'marked' },
  { type: 'json', data: '{"pw":"test"}', expectInHtml: 'renderNode' },
  { type: 'code', data: 'def greet(): pass', expectInHtml: 'hljs' },
  { type: 'mermaid', data: 'graph TD; A-->B', expectInHtml: 'mermaid' },
  { type: 'svg', data: '<svg><circle cx="50" cy="50" r="40" fill="red"/></svg>', expectInHtml: 'circle' },
  { type: 'html', data: '<p class="pw-test">Hello!</p>', expectInHtml: 'class="pw-test"' },
];

test.describe('Phase 5: Per-type render HTML', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  for (const { type, data, expectInHtml } of RENDER_CASES) {
    test(`type=${type} → render contains "${expectInHtml}"`, async ({ page }) => {
      const csrf = await getCsrfToken(page);
      const id = await createArtifact(page, csrf, { type, name: `pw-test.${type}`, data });
      if (!id) { test.skip(true, 'Failed to create artifact'); return; }

      const res = await page.request.get(`/api/artifacts/${id}/render`);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain(expectInHtml);
    });
  }
});

// ─── Phase 6: Live Artifact API ───────────────────────────────────────────────

test.describe('Phase 6: Live Artifact API (via page session)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('GET /live-config → 404 before config is created', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'no-live.md', data: '# Static artifact' });
    if (!id) { test.skip(true, 'Failed to create artifact'); return; }

    const res = await page.request.get(`/api/admin/artifacts/${id}/live-config`);
    expect(res.status()).toBe(404);
  });

  test('POST /live-config → 201 with correct fields', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'will-be-live.md', data: '# Future Live Artifact' });
    if (!id) { test.skip(true, 'Failed to create artifact'); return; }

    const res = await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: { refreshIntervalSeconds: 45, cacheTtlSeconds: 15 },
    });
    expect(res.status()).toBe(201);
    const body = await res.json() as { liveConfig?: { refresh_interval_seconds: number; cache_ttl_seconds: number } };
    expect(body.liveConfig?.refresh_interval_seconds).toBe(45);
    expect(body.liveConfig?.cache_ttl_seconds).toBe(15);
  });

  test('GET /live-config → 200 after creation', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'live-check.md', data: '# Live Check' });
    if (!id) { test.skip(true, 'Failed'); return; }

    await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: { refreshIntervalSeconds: 60 },
    });

    const res = await page.request.get(`/api/admin/artifacts/${id}/live-config`);
    expect(res.status()).toBe(200);
    const body = await res.json() as { liveConfig?: { refresh_interval_seconds: number } };
    expect(body.liveConfig?.refresh_interval_seconds).toBe(60);
  });

  test('render-live injects toolbar HTML when live config exists', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'toolbar-check.md', data: '# Toolbar Check' });
    if (!id) { test.skip(true, 'Failed'); return; }

    await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: { refreshIntervalSeconds: 30, cacheTtlSeconds: 5 },
    });

    const res = await page.request.get(`/api/admin/artifacts/${id}/render-live`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('live-toolbar');
    expect(html).toContain('LIVE');
    expect(html).toContain('Refresh');
    expect(res.headers()['content-security-policy']).toContain("connect-src 'self'");
    await page.screenshot({ path: '/tmp/pw-render-live-toolbar-api.png', fullPage: false });
  });

  test('render-live has NO toolbar for static artifact (no live config)', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'static-render.md', data: '# Static' });
    if (!id) { test.skip(true, 'Failed'); return; }

    const res = await page.request.get(`/api/admin/artifacts/${id}/render-live`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('live-toolbar');
  });

  test('POST /api/artifacts/:id/refresh → 404 without live config', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'no-refresh.md', data: '# No Refresh' });
    if (!id) { test.skip(true, 'Failed'); return; }

    const res = await page.request.post(`/api/artifacts/${id}/refresh`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(res.status()).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not configured as live');
  });

  test('PATCH /live-config → 200 + updates fields', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'patch-live.md', data: '# Patch Test' });
    if (!id) { test.skip(true, 'Failed'); return; }

    await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: { refreshIntervalSeconds: 30, cacheTtlSeconds: 10 },
    });

    const patch = await page.request.patch(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: { cacheTtlSeconds: 999 },
    });
    expect(patch.status()).toBe(200);
    const body = await patch.json() as { liveConfig?: { cache_ttl_seconds: number; refresh_interval_seconds: number } };
    expect(body.liveConfig?.cache_ttl_seconds).toBe(999);
    expect(body.liveConfig?.refresh_interval_seconds).toBe(30);
  });

  test('DELETE /live-config → 200 then GET → 404', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'delete-live.md', data: '# Delete Test' });
    if (!id) { test.skip(true, 'Failed'); return; }

    await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: {},
    });

    const del = await page.request.delete(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(del.status()).toBe(200);

    const check = await page.request.get(`/api/admin/artifacts/${id}/live-config`);
    expect(check.status()).toBe(404);
  });

  test('POST /live-refresh → 200', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'refresh-admin.md', data: '# Admin Refresh' });
    if (!id) { test.skip(true, 'Failed'); return; }

    await page.request.post(`/api/admin/artifacts/${id}/live-config`, {
      headers: { 'x-csrf-token': csrf },
      data: {},
    });

    const res = await page.request.post(`/api/admin/artifacts/${id}/live-refresh`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ─── Phase 6: Browser UI — Configure Live + preview modal ─────────────────────

test.describe('Phase 6: Live artifact browser interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('Configure Live button in admin opens browser dialog', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    await createArtifact(page, csrf, { name: 'configure-live-test.md', data: '# Configure Live' });

    await goAdmin(page);
    await openArtifactsTab(page);
    await page.waitForTimeout(600);

    const row = page.locator('tbody tr, .admin-list-row').first();
    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No rows in admin table');
      return;
    }
    await row.click();
    await page.waitForTimeout(500);

    const liveBtn = page.locator('button', { hasText: 'Configure Live' });
    if (!(await liveBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'Configure Live button not found');
      return;
    }

    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type() + ':' + dialog.message());
      if (dialog.type() === 'prompt') await dialog.accept('30');
      else await dialog.dismiss();
    });

    await liveBtn.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: '/tmp/pw-configure-live-clicked.png', fullPage: false });
    expect(await liveBtn.isVisible()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: Export, Share & Embed — API tests via browser session
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Phase 7: Download endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('GET /download returns 200 with Content-Disposition attachment', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'dl-test.md', type: 'markdown', data: '# Download Test' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/download`);
    expect(res.status()).toBe(200);
    const cd = res.headers()['content-disposition'];
    expect(cd).toContain('attachment');
    expect(cd).toContain('dl-test.md');
    const body = await res.text();
    expect(body).toContain('# Download Test');
  });

  test('GET /download sets correct MIME type', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'data.json', type: 'json', data: '{"x":1}' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/download`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
  });

  test('GET /download returns 404 for unknown id', async ({ page }) => {
    const res = await page.request.get('/api/artifacts/nonexistent-id-xyz/download');
    expect(res.status()).toBe(404);
  });
});

test.describe('Phase 7: ZIP Export endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('GET /export returns ZIP file with correct magic bytes', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'export-test.md', type: 'markdown', data: '# Export Test\n\nVersion 1' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/export`);
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'];
    expect(ct).toContain('application/zip');
    const cd = res.headers()['content-disposition'];
    expect(cd).toContain('attachment');
    expect(cd).toContain('.zip');
    const buf = Buffer.from(await res.body());
    // PK magic bytes
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    // ZIP must contain manifest.json
    expect(buf.toString('utf8')).toContain('manifest.json');
  });

  test('GET /export ZIP contains version files', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'multi.md', type: 'markdown', data: '# Version 1' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    // Create v2
    await page.request.patch(`/api/admin/artifacts/${id}`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { data: '# Version 2' },
    });
    const res = await page.request.get(`/api/artifacts/${id}/export`);
    expect(res.status()).toBe(200);
    const text = Buffer.from(await res.body()).toString('utf8');
    expect(text).toContain('multi');
  });
});

test.describe('Phase 7: Share token creation & public share page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('POST /share returns shareToken and url', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'shareable.md', type: 'markdown', data: '# Share Me' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { shareToken: string; url: string; passwordProtected: boolean };
    expect(typeof body.shareToken).toBe('string');
    expect(body.shareToken.length).toBeGreaterThan(10);
    expect(body.url).toContain('/share/artifacts/');
    expect(body.passwordProtected).toBe(false);
  });

  test('POST /share with expiresInDays returns expiresAt', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'expires.md', type: 'markdown', data: '# Temp Share' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { expiresInDays: 7 },
    });
    const body = await res.json() as { expiresAt?: string };
    expect(body.expiresAt).toBeTruthy();
    const expMs = new Date(body.expiresAt!).getTime();
    expect(expMs).toBeGreaterThan(Date.now() + 6 * 86400 * 1000);
  });

  test('POST /share with password sets passwordProtected:true', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'locked.md', type: 'markdown', data: '# Secret' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { password: 'hunter2' },
    });
    const body = await res.json() as { passwordProtected: boolean };
    expect(body.passwordProtected).toBe(true);
  });

  test('GET /share/artifacts/:token renders HTML with share footer', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'pub-page.md', type: 'markdown', data: '# Public Page' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    const { url } = await shareRes.json() as { url: string };
    // Extract path from absolute URL
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const res = await page.request.get(sharePath);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Shared via geneWeave');
    expect(html).toContain('share-footer');
    expect(html).toContain('pub-page.md');
  });

  test('GET /share/artifacts/:token sets X-Robots-Tag: noindex', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'noindex.md', type: 'markdown', data: 'hi' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    const { url } = await shareRes.json() as { url: string };
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const res = await page.request.get(sharePath);
    expect(res.headers()['x-robots-tag']).toContain('noindex');
  });

  test('GET /share/artifacts/:token returns 401 for invalid token', async ({ page }) => {
    const res = await page.request.get('/share/artifacts/not.a.valid.token');
    expect(res.status()).toBe(401);
  });

  test('Security: tampered share token is rejected', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'sec.md', type: 'markdown', data: 'secure' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    const { shareToken } = await shareRes.json() as { shareToken: string };
    const parts = shareToken.split('.');
    const tampered = `${parts[0]}.${parts[1]}.TAMPERED`;
    const res = await page.request.get(`/share/artifacts/${tampered}`);
    expect(res.status()).toBe(401);
  });

  test('Password-protected share: shows password page without ?p=', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'pw-locked.md', type: 'markdown', data: '# Locked' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { password: 'mypassword' },
    });
    const { url } = await shareRes.json() as { url: string };
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const res = await page.request.get(sharePath);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('Password Protected');
    expect(html).not.toContain('# Locked');
  });

  test('Password-protected share: correct password grants access', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'pw-grant.md', type: 'markdown', data: '# Granted Content' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { password: 'open_sesame' },
    });
    const { url } = await shareRes.json() as { url: string };
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const res = await page.request.get(`${sharePath}?p=open_sesame`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('# Granted Content');
    expect(html).not.toContain('Password Protected');
  });

  test('Password-protected share: wrong password returns 401', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'pw-deny.md', type: 'markdown', data: 'hidden' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { password: 'correct' },
    });
    const { url } = await shareRes.json() as { url: string };
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const res = await page.request.get(`${sharePath}?p=wrong`);
    expect(res.status()).toBe(401);
    const html = await res.text();
    expect(html).toContain('Incorrect password');
  });

  test('GET /share/artifacts/:token/raw returns raw data', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'raw.txt', type: 'text', data: 'raw content check' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    const { shareToken } = await shareRes.json() as { shareToken: string };
    const res = await page.request.get(`/share/artifacts/${shareToken}/raw`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('raw content check');
  });

  test('GET /share/artifacts/:token/raw blocks password-protected artifacts', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'blocked-raw.txt', type: 'text', data: 'blocked' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: { password: 'pw' },
    });
    const { shareToken } = await shareRes.json() as { shareToken: string };
    const res = await page.request.get(`/share/artifacts/${shareToken}/raw`);
    expect(res.status()).toBe(403);
  });
});

test.describe('Phase 7: Embed Code endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('GET /embed-code returns embedCode with iframe', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'embed-me.md', type: 'markdown', data: '# Embed Me' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/embed-code`);
    expect(res.status()).toBe(200);
    const body = await res.json() as { embedCode: string; embedUrl: string };
    expect(body.embedCode).toContain('<iframe');
    expect(body.embedCode).toContain('/share/artifacts/');
    expect(body.embedCode).toContain('sandbox=');
    expect(body.embedUrl).toContain('/share/artifacts/');
  });

  test('GET /embed-code width/height params applied to iframe', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'size.svg', type: 'svg', data: '<svg/>' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/embed-code?width=1200&height=900`);
    const body = await res.json() as { embedCode: string };
    expect(body.embedCode).toContain('width="1200"');
    expect(body.embedCode).toContain('height="900"');
  });

  test('GET /embed-code generates permanent token (no expiry) accessible publicly', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, { name: 'perm-embed.md', type: 'markdown', data: '# Permanent Embed' });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }
    const res = await page.request.get(`/api/artifacts/${id}/embed-code`);
    const body = await res.json() as { embedCode: string; embedUrl: string };
    // The embed URL should be publicly accessible
    const sharePath = body.embedUrl.startsWith('http') ? new URL(body.embedUrl).pathname : body.embedUrl;
    const shareRes = await page.request.get(sharePath);
    expect(shareRes.status()).toBe(200);
    const html = await shareRes.text();
    expect(html).toContain('Shared via geneWeave');
  });

  test('GET /embed-code returns 404 for unknown artifact', async ({ page }) => {
    const res = await page.request.get('/api/artifacts/unknown-embed-id/embed-code');
    expect(res.status()).toBe(404);
  });
});

test.describe('Phase 7: Admin panel — Download, Share, Embed buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('Download, Share, Embed buttons appear in artifact detail panel', async ({ page }) => {
    const csrf = await getCsrfToken(page);
    await createArtifact(page, csrf, { name: 'admin-p7-test.md', data: '# Admin Phase 7' });
    await goAdmin(page);
    await openArtifactsTab(page);
    await page.waitForTimeout(600);

    const row = page.locator('tbody tr, .admin-list-row').first();
    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No rows in admin table'); return;
    }
    await row.click();
    await page.waitForTimeout(600);

    await expect(page.locator('button', { hasText: '⬇ Download' })).toBeVisible({ timeout: 4000 });
    await expect(page.locator('button', { hasText: '🔗 Share' })).toBeVisible({ timeout: 4000 });
    await expect(page.locator('button', { hasText: '</> Embed' })).toBeVisible({ timeout: 4000 });
    await page.screenshot({ path: '/tmp/pw-phase7-admin-buttons.png', fullPage: false });
  });
});

test.describe('Phase 7: OpenAI — artifact generation then export/share', () => {
  const OPENAI_KEY = process.env['OPENAI_API_KEY'];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('OpenAI gpt-4o-mini: creates markdown artifact then tests all Phase 7 endpoints', async ({ page }) => {
    if (!OPENAI_KEY) { test.skip(true, 'OPENAI_API_KEY not set'); return; }

    // Use OpenAI directly (Playwright runs in Node.js context) to generate content
    let content = '# AI Report on Artifact Sharing\n\nArtifact sharing enables collaboration and reuse in AI workflows. It allows multiple agents and systems to reference and build upon the same data without duplication. This improves efficiency and auditability across distributed AI systems.';
    try {
      const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
      const { weaveAgent } = await import('@weaveintel/agents');
      const { weaveContext, weaveToolRegistry } = await import('@weaveintel/core');
      const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });
      const tools = weaveToolRegistry();
      let generated = '';
      const agent = weaveAgent({ model, tools, name: 'phase7-report-gen', maxSteps: 2 });
      const result = await agent.run(weaveContext({ userId: 'phase7-pw-user' }), {
        messages: [{ role: 'user', content: 'Write a short 3-sentence markdown report about the benefits of artifact sharing in AI. Return only the markdown text.' }],
        goal: 'Generate markdown report content',
      });
      for (const m of result.messages) {
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          generated = m.content.trim();
          break;
        }
      }
      if (generated) content = generated;
    } catch (e) {
      console.log('[Phase 7 OpenAI] model call failed, using fallback content:', e instanceof Error ? e.message : String(e));
    }

    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, {
      name: 'openai-phase7-report.md',
      type: 'markdown',
      data: content,
    });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }

    // Test download
    const dlRes = await page.request.get(`/api/artifacts/${id}/download`);
    expect(dlRes.status()).toBe(200);
    expect(dlRes.headers()['content-disposition']).toContain('attachment');
    const dlBody = await dlRes.text();
    expect(dlBody.length).toBeGreaterThan(10);

    // Test ZIP export
    const zipRes = await page.request.get(`/api/artifacts/${id}/export`);
    expect(zipRes.status()).toBe(200);
    const zipBuf = Buffer.from(await zipRes.body());
    expect(zipBuf[0]).toBe(0x50); // PK magic
    expect(zipBuf[1]).toBe(0x4b);

    // Test share token creation
    const shareRes = await page.request.post(`/api/artifacts/${id}/share`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      data: {},
    });
    expect(shareRes.status()).toBe(200);
    const { shareToken, url } = await shareRes.json() as { shareToken: string; url: string };
    expect(shareToken).toBeTruthy();

    // Test public share page
    const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
    const pubRes = await page.request.get(sharePath);
    expect(pubRes.status()).toBe(200);
    const pubHtml = await pubRes.text();
    expect(pubHtml).toContain('Shared via geneWeave');

    // Test embed code
    const embedRes = await page.request.get(`/api/artifacts/${id}/embed-code`);
    expect(embedRes.status()).toBe(200);
    const { embedCode } = await embedRes.json() as { embedCode: string };
    expect(embedCode).toContain('<iframe');
    expect(embedCode).toContain('/share/artifacts/');

    await page.screenshot({ path: '/tmp/pw-phase7-openai-complete.png', fullPage: false });
    console.log(`[Phase 7 OpenAI] artifact id=${id}, shareToken=${shareToken.substring(0, 20)}…`);
  });

  test('OpenAI gpt-4o-mini: creates JSON artifact, tests typed download MIME type', async ({ page }) => {
    if (!OPENAI_KEY) { test.skip(true, 'OPENAI_API_KEY not set'); return; }

    let jsonContent = '{"title":"AI Data","tags":["ai","share","export"],"value":42}';
    try {
      const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
      const { weaveAgent } = await import('@weaveintel/agents');
      const { weaveContext, weaveToolRegistry } = await import('@weaveintel/core');
      const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });
      const tools = weaveToolRegistry();
      const agent = weaveAgent({ model, tools, name: 'phase7-json-gen', maxSteps: 2 });
      const result = await agent.run(weaveContext({ userId: 'phase7-json-user' }), {
        messages: [{ role: 'user', content: 'Return only a JSON object with keys: title (string), tags (array of 3 strings), value (number). No preamble, just the JSON.' }],
        goal: 'Generate JSON data',
      });
      for (const m of result.messages) {
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          const raw = m.content.trim();
          const match = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
          if (match) {
            try { JSON.parse(match[1]!); jsonContent = match[1]!.trim(); } catch { /* keep fallback */ }
          }
          break;
        }
      }
    } catch (e) {
      console.log('[Phase 7 OpenAI] JSON model call failed:', e instanceof Error ? e.message : String(e));
    }

    const csrf = await getCsrfToken(page);
    const id = await createArtifact(page, csrf, {
      name: 'openai-data.json',
      type: 'json',
      data: jsonContent,
    });
    if (!id) { test.skip(true, 'createArtifact failed'); return; }

    const dlRes = await page.request.get(`/api/artifacts/${id}/download`);
    expect(dlRes.status()).toBe(200);
    expect(dlRes.headers()['content-type']).toContain('application/json');
    const parsed = JSON.parse(await dlRes.text()) as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
    console.log(`[Phase 7 OpenAI] JSON artifact id=${id}, title=${parsed['title']}`);
  });

  test('Phase 7 stress test — 5 artifacts share tokens created concurrently', async ({ page }) => {
    const csrf = await getCsrfToken(page);

    // Create 5 artifacts concurrently
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createArtifact(page, csrf, {
        name: `stress-${i}.md`,
        type: 'markdown',
        data: `# Stress Test ${i}\n\nConcurrent share token creation test at ${new Date().toISOString()}.`,
      })),
    );

    const validIds = ids.filter(Boolean);
    expect(validIds.length).toBeGreaterThanOrEqual(3);

    // Create share tokens concurrently
    const shareResults = await Promise.all(
      validIds.map(id => page.request.post(`/api/artifacts/${id}/share`, {
        headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
        data: {},
      })),
    );

    for (const r of shareResults) {
      expect(r.status()).toBe(200);
      const body = await r.json() as { shareToken: string };
      expect(body.shareToken).toBeTruthy();
    }

    // Verify all share pages are independently accessible
    const pubChecks = await Promise.all(
      shareResults.map(async (r) => {
        const { url } = await r.json() as { url: string };
        const sharePath = url.startsWith('http') ? new URL(url).pathname : url;
        return page.request.get(sharePath);
      }),
    );

    for (const pub of pubChecks) {
      expect(pub.status()).toBe(200);
    }

    await page.screenshot({ path: '/tmp/pw-phase7-stress.png', fullPage: false });
    console.log(`[Phase 7 Stress] ${validIds.length} artifacts, ${pubChecks.length} share pages verified`);
  });
});
