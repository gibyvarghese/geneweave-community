/**
 * Playwright E2E — Cache Phase 7 (stampede protection) with a real LLM (OpenAI).
 *
 * Proves, end to end with a real (slow) model, that N concurrent identical
 * requests COALESCE into a single in-flight computation — across direct, agent
 * AND supervisor modes — observed via the live singleflight stats endpoint.
 * Plus the operator surface: cache-settings (stampede toggle + eviction policy)
 * and cache-policies (swr / negative / eviction) persist, and the admin UI tab.
 *
 * Admin routes require admin:tenant:write → the FIRST registered user (admin).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';
const ADMIN = 'cache-p7-admin@weaveintel.dev';

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
async function stampedeStats(page: Page): Promise<{ flights: number; coalesced: number; inFlight: number }> {
  const r = await page.request.get('/api/admin/stampede/stats');
  expect(r.ok(), `stampede stats failed: ${r.status()}`).toBeTruthy();
  return ((await r.json()) as { stats: { flights: number; coalesced: number; inFlight: number } }).stats;
}
async function newChat(page: Page, token: string, mode: string): Promise<string> {
  const c = await page.request.post('/api/chats', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { title: 'Cache P7' } });
  const { chat } = await c.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { mode, enabledTools: [] },
  });
  return chat.id;
}
/**
 * Fire N identical requests TRULY concurrently from inside the browser (the
 * browser opens parallel connections, unlike Playwright's request context which
 * serialises over one socket — so the model calls actually overlap and coalesce).
 */
async function fireConcurrent(page: Page, token: string, chatIds: string[], content: string): Promise<void> {
  await page.evaluate(async ({ ids, prompt, token, provider, model }) => {
    await Promise.all(ids.map((id) =>
      fetch(`/api/chats/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ content: prompt, stream: false, provider, model, maxTokens: 96 }),
      }).then((r) => r.text()).catch(() => null),
    ));
  }, { ids: chatIds, prompt: content, token, provider: LLM_PROVIDER, model: LLM_MODEL });
}

test.describe.serial('Cache Phase 7 — stampede protection (real LLM)', () => {
  test.setTimeout(300_000);

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, ADMIN); // first user → tenant admin
    const token = await csrf(page);
    // Disable the semantic cache (so a paraphrase can't shadow the result) and
    // make sure stampede protection is ON.
    await page.request.put('/api/admin/semantic-cache-config', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { enabled: false } });
    await page.request.put('/api/admin/cache-settings', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { stampede_protection: true } });
    await ctx.close();
  });

  // Distinct cold-start prompts per mode (benign geography questions). Each
  // attempt uses a fresh country so the batch starts cold (no response-cache
  // hit) and must funnel through one in-flight leader.
  const COUNTRIES: Record<string, string[]> = {
    direct: ['France', 'Germany', 'Spain', 'Italy'],
    agent: ['Japan', 'Kenya', 'Peru', 'Egypt'],
    supervisor: ['Brazil', 'Canada', 'Norway', 'Chile'],
  };

  for (const mode of ['direct', 'agent', 'supervisor'] as const) {
    test(`coalesces concurrent identical ${mode}-mode requests into fewer model calls`, async ({ page }) => {
      await loginAs(page, ADMIN);
      const token = await csrf(page);
      const N = 6;
      const before = await stampedeStats(page);
      let after = before;
      // Retry with a fresh cold prompt until a burst coalesces (a slow reasoning
      // model can occasionally fail to overlap on a given burst).
      for (const country of COUNTRIES[mode]!) {
        if (after.coalesced > before.coalesced) break;
        const chatIds: string[] = [];
        for (let i = 0; i < N; i++) chatIds.push(await newChat(page, token, mode));
        await fireConcurrent(page, token, chatIds, `What is the capital of ${country}?`);
        after = await stampedeStats(page);
      }
      expect(after.coalesced, `${mode}: concurrent identical requests should coalesce into one in-flight leader`).toBeGreaterThan(before.coalesced);
    });
  }

  test('admin: cache-settings stampede toggle + eviction policy persist', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const put = await page.request.put('/api/admin/cache-settings', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { stampede_protection: true, l1_eviction_policy: 'gdsf', l1_negative_ttl_ms: 2000 },
    });
    expect(put.ok()).toBeTruthy();
    const settings = (await put.json())['cache-settings'] as Record<string, unknown>;
    expect(settings['l1_eviction_policy']).toBe('gdsf');
    expect(settings['stampede_protection']).toBe(1);
    expect(settings['l1_negative_ttl_ms']).toBe(2000);
    // restore default eviction policy
    await page.request.put('/api/admin/cache-settings', { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { l1_eviction_policy: 'lru' } });
  });

  test('admin: cache-policies swr / negative / eviction persist', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const list = await page.request.get('/api/admin/cache-policies');
    const policies = (await list.json())['cache-policies'] as Array<Record<string, unknown>>;
    const p = policies.find(x => x['enabled']) ?? policies[0]!;
    const put = await page.request.put(`/api/admin/cache-policies/${p['id']}`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { swr_ms: 30000, negative_ttl_ms: 1500, eviction_policy: 'tinylfu' },
    });
    expect(put.ok()).toBeTruthy();
    const updated = (await put.json())['cache-policy'] as Record<string, unknown>;
    expect(updated['swr_ms']).toBe(30000);
    expect(updated['negative_ttl_ms']).toBe(1500);
    expect(updated['eviction_policy']).toBe('tinylfu');
    // reset so other tests/users are unaffected
    await page.request.put(`/api/admin/cache-policies/${p['id']}`, { headers: { 'x-csrf-token': token, 'content-type': 'application/json' }, data: { swr_ms: 0, negative_ttl_ms: 0, eviction_policy: 'lru' } });
  });

  test('admin: stampede stats endpoint + Cache Settings tab renders', async ({ page }) => {
    await loginAs(page, ADMIN);
    const stats = await stampedeStats(page);
    expect(stats).toHaveProperty('flights');
    expect(stats).toHaveProperty('coalesced');

    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="cache-settings"]').first();
    if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
      const groups = page.locator('.admin-group-btn');
      const count = await groups.count();
      for (let i = 0; i < count; i++) { await groups.nth(i).click().catch(() => {}); if (await tab.isVisible({ timeout: 500 }).catch(() => false)) break; }
    }
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    await expect(page.locator('.main')).toContainText(/eviction|stampede/i, { timeout: 10000 });
  });
});
