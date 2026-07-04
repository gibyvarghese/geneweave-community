/**
 * Playwright E2E — Cache Phase 4 (semantic cache) with REAL embeddings.
 *
 * Uses the live OpenAI text-embedding-3-small embedder wired into the server.
 *  1. API: a PARAPHRASE of a previously-answered question is served from the
 *     semantic cache (cached + semantic) — on both non-streaming and streaming.
 *  2. Security: a DIFFERENT user never receives another user's cached answer
 *     (scope isolation), even for an identical query.
 *  3. Admin: the semantic-cache-config API round-trips and the admin UI tab
 *     renders the config.
 *
 * The chat answers come from a real LLM (OpenAI gpt-4o-mini).
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';
// The FIRST registered user on the server becomes the tenant admin (admin routes
// require admin:tenant:write). Register it first and use it for all admin ops.
const ADMIN = 'cache-p4-admin@weaveintel.dev';

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
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

async function lowerSemanticThreshold(page: Page, token: string): Promise<void> {
  // Conservative default is 0.92; loosen so a real paraphrase reliably hits.
  const res = await page.request.put('/api/admin/semantic-cache-config', {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    // Loose threshold so a near-identical paraphrase reliably hits with real
    // embeddings (well below any plausible paraphrase cosine).
    data: { enabled: true, similarity_threshold: 0.5, scope: 'user' },
  });
  expect(res.ok(), `PUT semantic-cache-config failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
}

async function newChat(page: Page, token: string): Promise<string> {
  const createRes = await page.request.post('/api/chats', {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { title: 'Cache P4' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { chat } = await createRes.json() as { chat: { id: string } };
  await page.request.post(`/api/chats/${chat.id}/settings`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { mode: 'direct', enabledTools: [] },
  });
  return chat.id;
}

async function send(page: Page, token: string, chatId: string, content: string, stream = false): Promise<APIResponse> {
  return page.request.post(`/api/chats/${chatId}/messages`, {
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    data: { content, stream, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 64 },
  });
}

function streamDone(body: string): Record<string, unknown> | null {
  let done: Record<string, unknown> | null = null;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try { const e = JSON.parse(t.slice(5).trim()) as Record<string, unknown>; if (e['type'] === 'done') done = e; } catch { /* */ }
  }
  return done;
}

test.describe.serial('Cache Phase 4 — semantic cache (real embeddings)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    // Register the admin user FIRST (→ tenant admin) and loosen the threshold so
    // real paraphrases reliably hit. The PUT resets the chat path's config cache.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, ADMIN);
    await lowerSemanticThreshold(page, await csrf(page));
    await ctx.close();
  });

  test('non-streaming: a paraphrase is served from the semantic cache', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const chatId = await newChat(page, token);

    // Original question → real LLM, stored semantically.
    const first = await send(page, token, chatId, 'What is the capital of France?');
    const firstJson = await first.json() as { semantic?: boolean };
    expect(firstJson.semantic ?? false).toBe(false);

    // Near-identical paraphrases (different exact text, very high cosine). Each
    // miss also stores itself, so a hit becomes robust even if one store lagged.
    let semantic = false;
    for (const q of [
      "What's the capital of France?",
      'What is the capital city of France?',
      'Whats the capital of France?',
      'What is the capital of France, please?',
    ]) {
      const r = await send(page, token, chatId, q);
      const j = await r.json() as { semantic?: boolean };
      if (j.semantic) { semantic = true; break; }
    }
    expect(semantic).toBe(true);
  });

  test('streaming: a paraphrase semantic hit surfaces in done.semantic', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);
    const chatId = await newChat(page, token);

    await (await send(page, token, chatId, 'Who wrote the play Romeo and Juliet?')).text();
    let done: Record<string, unknown> | null = null;
    for (const q of ['Who wrote Romeo and Juliet?', 'Who is the author of Romeo and Juliet?', 'Who wrote the play Romeo & Juliet?', 'Who authored Romeo and Juliet?']) {
      const res = await send(page, token, chatId, q, true);
      expect(res.ok()).toBeTruthy();
      done = streamDone(await res.text());
      if (done?.['semantic'] === true) break;
    }
    expect(done?.['semantic']).toBe(true);
    expect(done?.['cached']).toBe(true);
  });

  test('security: a different user never receives another user\'s cached answer', async ({ browser }) => {
    // Admin (user A) caches an answer.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginAs(pageA, ADMIN);
    const tokenA = await csrf(pageA);
    const chatA = await newChat(pageA, tokenA);
    await send(pageA, tokenA, chatA, 'What is the chemical symbol for gold?');

    // A DIFFERENT user (non-admin, separate scope) asks the same — must NOT hit.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginAs(pageB, 'cache-p4-userB@weaveintel.dev');
    const tokenB = await csrf(pageB);
    const chatB = await newChat(pageB, tokenB);
    // Even an IDENTICAL query must not hit across users (scope isolation).
    const res = await send(pageB, tokenB, chatB, 'What is the chemical symbol for gold?');
    const json = await res.json() as { semantic?: boolean };
    expect(json.semantic ?? false).toBe(false); // scope isolation across users

    await ctxA.close();
    await ctxB.close();
  });

  test('admin: semantic-cache-config round-trips via API and renders in the UI', async ({ page }) => {
    await loginAs(page, ADMIN);
    const token = await csrf(page);

    const getRes = await page.request.get('/api/admin/semantic-cache-config');
    expect(getRes.ok()).toBeTruthy();
    const cfg = (await getRes.json())['config'] as Record<string, unknown>;
    expect(cfg['id']).toBe('global');
    expect(cfg).toHaveProperty('similarity_threshold');

    const put = await page.request.put('/api/admin/semantic-cache-config', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { similarity_threshold: 0.88, scope: 'tenant', max_entries: 750 },
    });
    expect(put.ok()).toBeTruthy();
    const updated = (await put.json())['semantic-cache-config'] as Record<string, unknown>;
    expect(updated['similarity_threshold']).toBe(0.88);
    expect(updated['scope']).toBe('tenant');
    expect(updated['max_entries']).toBe(750);

    // UI: navigate to the Semantic Cache admin tab and verify it renders.
    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="semantic-cache-config"]').first();
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
    await expect(main.locator('th', { hasText: /embedding model/i }).first()).toBeVisible({ timeout: 10000 });
  });
});
