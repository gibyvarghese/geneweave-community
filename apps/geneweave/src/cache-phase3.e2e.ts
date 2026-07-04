/**
 * Playwright E2E — Cache Phase 3 (observability).
 *
 * 1. API: after real-LLM chat turns, GET /api/admin/cache-metrics reports the
 *    response-cache hit/miss rollup (a repeated prompt becomes a hit) and the
 *    live process snapshot.
 * 2. API: a large stable system prefix produces prompt-cache token savings that
 *    surface in the rollup (read tokens + estimated cost saved).
 * 3. UI: the admin "Cache Metrics" tab renders the rollup (read-only).
 *
 * Uses a real model (OpenAI gpt-4o-mini) — no mock.
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';

const EMAIL = 'cache-phase3@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';

const BIG_SYSTEM = (
  'You are geneWeave, an enterprise AI orchestration assistant. Follow these standing operating ' +
  'instructions precisely on every turn. '
).repeat(180);

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Cache P3', email: EMAIL, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

async function csrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

async function getMetrics(page: Page): Promise<{ summary: any; windows: any[]; live: any }> {
  const res = await page.request.get('/api/admin/cache-metrics');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { summary: body['summary'], windows: body['cache-metrics'], live: body['live'] };
}

async function newChat(page: Page, token: string, systemPrompt?: string): Promise<string> {
  const createRes = await page.request.post('/api/chats', {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { title: 'Cache P3' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { chat } = await createRes.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { mode: 'direct', enabledTools: [], ...(systemPrompt ? { systemPrompt } : {}) },
  });
  return chat.id;
}

async function send(page: Page, token: string, chatId: string, content: string): Promise<APIResponse> {
  return page.request.post(`/api/chats/${chatId}/messages`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 16 },
  });
}

test.describe('Cache Phase 3 — observability', () => {
  test.setTimeout(120_000);

  test('API: response-cache hit/miss rollup populates after real chat turns', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newChat(page, token);

    const before = await getMetrics(page);
    const prompt = 'What is two plus two? Answer with only the number.';
    // Cold miss (real LLM), then an identical turn → response-cache hit (no LLM).
    const r1 = await send(page, token, chatId, prompt);
    expect(r1.ok()).toBeTruthy();
    const r2 = await send(page, token, chatId, prompt);
    const r2json = await r2.json() as { cached?: boolean };
    expect(r2json.cached).toBe(true); // served from the response cache

    const after = await getMetrics(page);
    expect(after.summary.responseHits).toBeGreaterThanOrEqual(before.summary.responseHits + 1);
    expect(after.summary.responseMisses).toBeGreaterThanOrEqual(before.summary.responseMisses + 1);
    expect(after.summary.hitRate).toBeGreaterThan(0);
    expect(after.windows.length).toBeGreaterThan(0);
    // Live in-process snapshot is wired too.
    expect(after.live?.responseCache).toBeTruthy();
  });

  test('API: prompt-cache token savings surface in the rollup', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newChat(page, token, BIG_SYSTEM);

    const before = await getMetrics(page);
    // Warm up over a few DIFFERENT benign turns sharing the big system prefix
    // (OpenAI caching is best-effort) until read tokens register.
    const qs = [
      'What is the capital of France?',
      'What is the capital of Japan?',
      'What is the capital of Italy?',
      'What is the capital of Spain?',
    ];
    for (const q of qs) {
      const r = await send(page, token, chatId, q);
      expect(r.ok()).toBeTruthy();
      const m = await getMetrics(page);
      if (m.summary.promptCacheReadTokens > before.summary.promptCacheReadTokens) break;
    }
    const after = await getMetrics(page);
    expect(after.summary.promptCacheReadTokens).toBeGreaterThan(before.summary.promptCacheReadTokens);
    expect(after.summary.costSavedUsd).toBeGreaterThan(before.summary.costSavedUsd);
  });

  test('UI: the Cache Metrics admin tab renders the rollup', async ({ page }) => {
    await ensureLoggedIn(page);
    // Generate at least one metrics row first.
    const token = await csrf(page);
    const chatId = await newChat(page, token);
    await send(page, token, chatId, 'What is three plus three? Answer with only the number.');

    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });

    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="cache-metrics"]').first();
    if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) {
        await groups.nth(i).click().catch(() => {});
        if (await tab.isVisible({ timeout: 500 }).catch(() => false)) break;
      }
    }
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();

    const main = page.locator('.main');
    // The rollup row(s) render: column headers are `col.replace(/_/g,' ')`.
    await expect(main.locator('th', { hasText: /response hits/i }).first()).toBeVisible({ timeout: 10000 });
    await expect(main.locator('th', { hasText: /window start/i }).first()).toBeVisible();
    // Read-only tab: no "+ New" create button.
    await expect(main.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ })).toHaveCount(0);
  });
});
