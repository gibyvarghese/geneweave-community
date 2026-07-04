/**
 * Playwright E2E — Cache Phase 6 (tool-result caching) with a real LLM (OpenAI).
 *
 * Proves, end to end through a real agent run, that an identical read-only tool
 * call (the `calculator`) is served from cache on a repeat — skipping the
 * underlying invoke — and that the operator surface works:
 *   1. real-LLM agent run calls the calculator → a tool-cache entry is created
 *      (sets↑) [SEND path];
 *   2. a SECOND agent run (different prompt wording, SAME exact expression) is a
 *      tool-cache HIT (hits↑) — response-cache can't mask it because the prompts
 *      differ;
 *   3. the STREAMING path also populates the same tool cache;
 *   4. admin `tool-cache-policies` API CRUD + seeded list + the admin UI tab.
 *
 * Admin routes require admin:tenant:write → the FIRST registered user (admin).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';
const ADMIN = 'cache-p6-admin@weaveintel.dev';
// A fixed expression embedded verbatim in both prompts → the model copies the
// same string into the calculator → identical tool args → a deterministic key.
const EXPR = '81234 * 5678';

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
async function toolStats(page: Page): Promise<{ hits: number; misses: number; sets: number; entries: number }> {
  const r = await page.request.get('/api/admin/tool-cache/stats');
  expect(r.ok(), `stats failed: ${r.status()}`).toBeTruthy();
  return ((await r.json()) as { stats: { hits: number; misses: number; sets: number; entries: number } }).stats;
}
/** Create an agent-mode chat with the calculator tool enabled. */
async function newCalcChat(page: Page, token: string): Promise<string> {
  const c = await page.request.post('/api/chats', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { title: 'Cache P6' } });
  const { chat } = await c.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { mode: 'agent', enabledTools: ['calculator'] },
  });
  return chat.id;
}
// Benign, varied lead-ins → each agent run gets a DISTINCT response-cache key
// (so the response cache never short-circuits the turn), while the embedded
// expression stays identical (so the calculator's args — and thus its cache key
// — match across runs).
const LEADS = [
  "I'm checking some arithmetic.",
  'Quick number question.',
  'Help me with a sum.',
  'A small math task.',
  'One more calculation.',
  'Crunching some numbers.',
  'Need a product worked out.',
  'Another arithmetic question.',
];
function calcPrompt(lead: string): string {
  // Natural phrasing (imperative "call the tool with exactly…" trips the output
  // guardrail). The expression appears verbatim so the model reuses it as-is.
  return `${lead} What is the value of ${EXPR}? Please use the calculator tool to compute it.`;
}
async function sendAgent(page: Page, token: string, chatId: string, content: string): Promise<void> {
  const r = await page.request.post(`/api/chats/${chatId}/messages`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 512 },
  });
  expect(r.ok(), `send failed: ${r.status()} ${await r.text().catch(() => '')}`).toBeTruthy();
}
async function streamAgent(page: Page, token: string, chatId: string, content: string): Promise<void> {
  const r = await page.request.post(`/api/chats/${chatId}/messages/stream`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 512 },
  });
  expect(r.ok(), `stream failed: ${r.status()}`).toBeTruthy();
  await r.text(); // drain the SSE stream to completion
}

test.describe.serial('Cache Phase 6 — tool-result caching (real LLM)', () => {
  test.setTimeout(300_000);

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, ADMIN); // first user → tenant admin
    await ctx.close();
  });

  test('agent run caches the calculator result; an identical call is a HIT (send path)', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const base = await toolStats(page);

    // Phase A — WARM: real agent runs until the model actually invokes the
    // calculator (a reasoning model may occasionally answer mentally → retry).
    let warm = base;
    for (let i = 0; i < 4 && warm.entries === base.entries; i++) {
      const c = await newCalcChat(page, token);
      await sendAgent(page, token, c, calcPrompt(LEADS[i]!));
      warm = await toolStats(page);
    }
    expect(warm.entries, 'a real agent run should cache a calculator result').toBeGreaterThan(base.entries);

    // Phase B — HIT: differently-worded prompts (distinct response-cache keys)
    // carrying the SAME expression → identical tool args → a warm-cache HIT.
    const hitsBefore = warm.hits;
    let stats = warm;
    for (let i = 0; i < 6 && stats.hits === hitsBefore; i++) {
      const c = await newCalcChat(page, token);
      await sendAgent(page, token, c, calcPrompt(LEADS[(i + 4) % LEADS.length]!));
      stats = await toolStats(page);
    }
    expect(stats.hits, 'an identical calculator call should hit the warm tool cache').toBeGreaterThan(hitsBefore);
  });

  test('streaming agent run also flows through the cached tool registry (stream path)', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const before = await toolStats(page);
    // Retry until a streaming agent run actually calls the calculator; a fresh
    // set OR a hit on the already-warm entry both prove the streaming path uses
    // the cached registry.
    let after = before;
    for (let i = 0; i < 4 && (after.hits + after.sets) === (before.hits + before.sets); i++) {
      const chat = await newCalcChat(page, token);
      await streamAgent(page, token, chat, calcPrompt(LEADS[i]!));
      after = await toolStats(page);
    }
    expect(after.hits + after.sets, 'a streaming agent run should touch the tool cache').toBeGreaterThan(before.hits + before.sets);
  });

  test('admin: tool-cache-policies API CRUD + seeded list', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);

    const list = await page.request.get('/api/admin/tool-cache-policies');
    expect(list.ok()).toBeTruthy();
    const policies = (await list.json())['tool-cache-policies'] as Array<Record<string, unknown>>;
    expect(policies.some(p => p['tool_name'] === 'calculator' && p['cacheable'] === 1)).toBe(true);
    expect(policies.some(p => p['tool_name'] === 'web_search')).toBe(true);

    const created = await page.request.post('/api/admin/tool-cache-policies', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { tool_name: 'e2e_tool', cacheable: true, ttl_ms: 4242, enabled: true },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json())['tool-cache-policy'] as Record<string, unknown>)['id'] as string;

    const upd = await page.request.put(`/api/admin/tool-cache-policies/${id}`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { ttl_ms: 9001, cacheable: false },
    });
    expect(upd.ok()).toBeTruthy();
    expect(((await upd.json())['tool-cache-policy'] as Record<string, unknown>)['ttl_ms']).toBe(9001);

    await page.request.delete(`/api/admin/tool-cache-policies/${id}`, { headers: { 'x-csrf-token': token } });
    const after = await page.request.get('/api/admin/tool-cache-policies');
    expect(((await after.json())['tool-cache-policies'] as Array<Record<string, unknown>>).some(p => p['id'] === id)).toBe(false);
  });

  test('admin: Tool Cache tab renders', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="tool-cache-policies"]').first();
    if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) { await groups.nth(i).click().catch(() => {}); if (await tab.isVisible({ timeout: 500 }).catch(() => false)) break; }
    }
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    await expect(page.locator('.main').locator('th', { hasText: /tool.?name/i }).first()).toBeVisible({ timeout: 10000 });
  });
});
