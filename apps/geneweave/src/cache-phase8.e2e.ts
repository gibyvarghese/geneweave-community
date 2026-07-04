/**
 * Playwright E2E — Cache Phase 8 (Agentic Plan Caching) with a real LLM (OpenAI).
 *
 * Proves, end to end with a real model, that a structured plan from a finished
 * agent/supervisor task is reused for a SEMANTICALLY-SIMILAR later task — the
 * second run records a plan-cache HIT (observed via the live plan-cache stats
 * endpoint) — across supervisor AND agent modes. Plus the operator surface:
 * agent-plan-cache-config persists, the stats endpoint works, and the admin tab.
 *
 * Admin routes require admin:tenant:write → the FIRST registered user (admin).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';
const ADMIN = 'cache-p8-admin@weaveintel.dev';

async function loginAs(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  return r.ok() ? (((await r.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
}
async function planStats(page: Page): Promise<{ enabled: boolean; hits: number; misses: number; stores: number }> {
  const r = await page.request.get('/api/admin/plan-cache/stats');
  expect(r.ok(), `plan stats failed: ${r.status()}`).toBeTruthy();
  return ((await r.json()) as { stats: { enabled: boolean; hits: number; misses: number; stores: number } }).stats;
}
async function newChat(page: Page, token: string, mode: string): Promise<string> {
  const c = await page.request.post('/api/chats', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { title: 'Cache P8' } });
  const { chat } = await c.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { mode, enabledTools: ['calculator'] },
  });
  return chat.id;
}
async function send(page: Page, token: string, chatId: string, content: string): Promise<void> {
  const r = await page.request.post(`/api/chats/${chatId}/messages`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 400 },
  });
  expect(r.ok(), `send failed: ${r.status()} ${await r.text().catch(() => '')}`).toBeTruthy();
}
// A shared, benign template with a single variable (the city) → high goal
// similarity across variants, but distinct prompts, so the RESPONSE cache
// misses while the PLAN cache matches. Benign phrasing avoids the output
// guardrail (imperative / "explain what it represents" wording trips it).
const CITIES = ['Paris', 'Rome', 'Tokyo', 'Cairo', 'Oslo', 'Lima', 'Madrid', 'Berlin', 'Lisbon', 'Vienna', 'Dublin', 'Athens'];
function task(city: string): string {
  return `List three popular tourist attractions in ${city}.`;
}

test.describe.serial('Cache Phase 8 — Agentic Plan Caching (real LLM)', () => {
  test.setTimeout(300_000);

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, ADMIN); // first user → tenant admin
    const token = await csrf(page);
    // Disable the response semantic cache (so a similar prompt can't short-circuit
    // the turn before the agent runs) and make plan caching eager: cache any
    // completed run (min_steps=1) and reuse at a forgiving similarity (0.8).
    await page.request.put('/api/admin/semantic-cache-config', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { enabled: false } });
    // Plan matching is fuzzy guidance (not a replayed answer), so a lower
    // threshold is appropriate — distinct proper nouns drag real-embedding cosine
    // to ~0.75 even for an identical template (the Phase 4 finding).
    await page.request.put('/api/admin/agent-plan-cache-config', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { enabled: true, min_steps: 1, similarity_threshold: 0.7 } });
    await ctx.close();
  });

  for (const mode of ['supervisor', 'agent'] as const) {
    test(`reuses a plan from a similar ${mode}-mode task (store → hit)`, async ({ page }) => {
      await loginAs(page, ADMIN);
      const token = await csrf(page);
      const stats0 = await planStats(page);
      expect(stats0.enabled, 'plan cache must be active (embedding model available)').toBe(true);

      // Phase A — STORE: run benign similar tasks until a completed run's plan is
      // distilled + stored (a guardrail-denied run won't store, so retry).
      let stored = stats0;
      let ci = 0;
      for (; ci < CITIES.length && stored.stores === stats0.stores; ci++) {
        const c = await newChat(page, token, mode);
        await send(page, token, c, task(CITIES[ci]!));
        stored = await planStats(page);
      }
      expect(stored.stores, `${mode}: a completed task should store a plan`).toBeGreaterThan(stats0.stores);

      // Phase B — HIT: a different city (semantically-similar goal) reuses the
      // stored plan as guidance → a plan-cache HIT. Retry across the remaining
      // cities in case the embedding similarity dips on one.
      let hit = stored;
      for (; ci < CITIES.length && hit.hits === stored.hits; ci++) {
        const c = await newChat(page, token, mode);
        await send(page, token, c, task(CITIES[ci]!));
        hit = await planStats(page);
      }
      expect(hit.hits, `${mode}: a similar task should reuse the cached plan`).toBeGreaterThan(stored.hits);
    });
  }

  test('admin: agent-plan-cache-config persists', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const put = await page.request.put('/api/admin/agent-plan-cache-config', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { enabled: true, similarity_threshold: 0.9, min_steps: 3, scope: 'tenant' },
    });
    expect(put.ok()).toBeTruthy();
    const cfg = (await put.json())['agent-plan-cache-config'] as Record<string, unknown>;
    expect(cfg['similarity_threshold']).toBe(0.9);
    expect(cfg['min_steps']).toBe(3);
    expect(cfg['scope']).toBe('tenant');
    // restore eager settings for any later runs
    await page.request.put('/api/admin/agent-plan-cache-config', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { similarity_threshold: 0.8, min_steps: 1, scope: 'user' } });
  });

  test('admin: plan-cache stats endpoint + Plan Cache tab renders', async ({ page }) => {
    await loginAs(page, ADMIN);
    const stats = await planStats(page);
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('stores');

    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="agent-plan-cache-config"]').first();
    if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) { await groups.nth(i).click().catch(() => {}); if (await tab.isVisible({ timeout: 500 }).catch(() => false)) break; }
    }
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    await expect(page.locator('.main')).toContainText(/threshold|plan/i, { timeout: 10000 });
  });
});
