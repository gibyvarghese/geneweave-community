/**
 * Playwright E2E — Cache Phase 5 (event-driven invalidation + versioning).
 *
 * With a real LLM (OpenAI), prove a warm cache hit becomes a miss after:
 *  1. admin "Invalidate Now" (all)           — manual invalidation;
 *  2. admin per-user invalidate (GDPR erasure);
 *  3. admin bumps the global_version_token    — versioned-key invalidation;
 *  4. a prompt-template update                — event-driven invalidation.
 * Plus: the cache-invalidation-rules admin API/UI.
 *
 * Admin routes require admin:tenant:write → the FIRST registered user (admin).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';
const ADMIN = 'cache-p5-admin@weaveintel.dev';

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
async function meId(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  return ((await r.json()) as { user?: { id: string } }).user?.id ?? '';
}
async function newChat(page: Page, token: string): Promise<string> {
  const c = await page.request.post('/api/chats', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { title: 'Cache P5' } });
  const { chat } = await c.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { mode: 'direct', enabledTools: [] } });
  return chat.id;
}
async function send(page: Page, token: string, chatId: string, content: string): Promise<{ cached?: boolean; semantic?: boolean }> {
  const r = await page.request.post(`/api/chats/${chatId}/messages`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 128 },
  });
  expect(r.ok(), `send failed: ${r.status()} ${await r.text().catch(() => '')}`).toBeTruthy();
  return r.json();
}
/** Send the prompt, then confirm a warm exact-cache hit on a repeat. */
async function cacheAndWarm(page: Page, token: string, chatId: string, prompt: string): Promise<void> {
  await send(page, token, chatId, prompt);
  const warm = await send(page, token, chatId, prompt);
  expect(warm.cached).toBe(true);
}

test.describe.serial('Cache Phase 5 — invalidation (real LLM)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    // Register the admin first AND disable the semantic cache so each test's
    // "miss after invalidation" is unambiguous (no paraphrase shadow-hit).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    await page.request.put('/api/admin/semantic-cache-config', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { enabled: false },
    });
    await ctx.close();
  });

  test('admin "Invalidate Now" (all) turns a warm hit into a miss', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const chatId = await newChat(page, token);
    await cacheAndWarm(page, token, chatId, 'What is the capital of Germany?');

    const inv = await page.request.post('/api/admin/cache/invalidate', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { all: true },
    });
    expect(inv.ok()).toBeTruthy();

    const after = await send(page, token, chatId, 'What is the capital of Germany?');
    expect(after.cached ?? false).toBe(false); // invalidated → miss
  });

  test('admin per-user invalidate (GDPR erasure) turns a warm hit into a miss', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const userId = await meId(page);
    const chatId = await newChat(page, token);
    await cacheAndWarm(page, token, chatId, 'What is the capital of Italy?');

    const inv = await page.request.post('/api/admin/cache/invalidate', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { userId },
    });
    expect(inv.ok()).toBeTruthy();
    expect((await inv.json())['cleared']).toBeGreaterThan(0);

    const after = await send(page, token, chatId, 'What is the capital of Italy?');
    expect(after.cached ?? false).toBe(false);
  });

  test('bumping global_version_token turns a warm hit into a miss', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const chatId = await newChat(page, token);
    await cacheAndWarm(page, token, chatId, 'What is the capital of Spain?');

    const put = await page.request.put('/api/admin/cache-settings', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { global_version_token: 'v-' + Date.now() },
    });
    expect(put.ok()).toBeTruthy();

    const after = await send(page, token, chatId, 'What is the capital of Spain?');
    expect(after.cached ?? false).toBe(false); // new key version → miss
  });

  test('event-driven: a prompt-template update invalidates the cache', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const chatId = await newChat(page, token);
    await cacheAndWarm(page, token, chatId, 'What is the capital of Portugal?');

    // Update any prompt → fires the seeded prompt_update clearAll rule.
    const prompts = (await (await page.request.get('/api/admin/prompts')).json())['prompts'] as Array<Record<string, unknown>>;
    expect(prompts.length).toBeGreaterThan(0);
    const p = prompts[0]!;
    const put = await page.request.put(`/api/admin/prompts/${p['id']}`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { enabled: p['enabled'] !== 0 }, // no-op toggle — avoids description validation
    });
    expect(put.ok(), `prompt PUT failed: ${put.status()} ${await put.text().catch(() => '')}`).toBeTruthy();

    const after = await send(page, token, chatId, 'What is the capital of Portugal?');
    expect(after.cached ?? false).toBe(false); // event cleared the cache → miss
  });

  test('admin: cache-invalidation-rules API + UI', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);

    const list = await page.request.get('/api/admin/cache-invalidation-rules');
    expect(list.ok()).toBeTruthy();
    const rules = (await list.json())['cache-invalidation-rules'] as Array<Record<string, unknown>>;
    expect(rules.some(r => r['trigger'] === 'prompt_update')).toBe(true);

    const created = await page.request.post('/api/admin/cache-invalidation-rules', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { name: 'E2E rule', trigger: 'manual', config: { clearAll: true }, enabled: true },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json())['cache-invalidation-rule'] as Record<string, unknown>)['id'] as string;
    await page.request.delete(`/api/admin/cache-invalidation-rules/${id}`, { headers: { 'x-csrf-token': token } });

    // UI tab renders.
    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="cache-invalidation-rules"]').first();
    if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) { await groups.nth(i).click().catch(() => {}); if (await tab.isVisible({ timeout: 500 }).catch(() => false)) break; }
    }
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    await expect(page.locator('.main').locator('th', { hasText: /trigger/i }).first()).toBeVisible({ timeout: 10000 });
  });
});
