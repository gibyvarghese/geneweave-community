/**
 * Playwright E2E — Cache Phase 1 (multi-tier config + streaming-path cache)
 *
 * 1. cache_settings admin API round-trips the multi-tier topology fields.
 * 2. Real-LLM streaming chat (`stream: true`) is cached: identical deterministic
 *    prompts produce a second response served from cache (`done.cached === true`).
 * 3. Streaming determinism gate: temperature > 0 is never cached.
 *
 * Uses a real model (OpenAI gpt-4o-mini) — no mock — per the caching requirement.
 */

import { test, expect, type Page, type APIResponse } from '@playwright/test';

const EMAIL = 'cache-phase1@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Cache P1', email: EMAIL, password: PASSWORD } });
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

/** Parse an SSE response body and return the parsed `done` event payload. */
async function parseDone(res: APIResponse): Promise<Record<string, unknown> | null> {
  expect(res.ok(), `stream failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
  const body = await res.text();
  let done: Record<string, unknown> | null = null;
  let denied = false;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const evt = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
      if (evt['type'] === 'guardrail' && evt['decision'] === 'deny') denied = true;
      if (evt['type'] === 'done') done = evt;
    } catch { /* heartbeat / non-JSON frame */ }
  }
  // Guard against a flaky guardrail denial masking the cache assertion.
  expect(denied, 'prompt was unexpectedly denied by a guardrail').toBe(false);
  return done;
}

// ─── 1. cache_settings admin API ─────────────────────────────

test.describe('Cache Phase 1 — cache_settings admin API', () => {
  test('round-trips the multi-tier topology fields', async ({ page }) => {
    await ensureLoggedIn(page);
    const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

    const getRes = await page.request.get('/api/admin/cache-settings');
    expect(getRes.ok()).toBeTruthy();
    // The GET wraps the single row in an array for the admin tab; `config` holds
    // the object form.
    const settings = (await getRes.json())['config'] as Record<string, unknown>;
    expect(settings['id']).toBe('global');
    expect(settings).toHaveProperty('l2_enabled');
    expect(settings).toHaveProperty('global_version_token');

    const putRes = await page.request.put('/api/admin/cache-settings', {
      headers,
      data: { l2_enabled: true, l2_provider: 'redis', l1_ttl_ms: 15000, key_namespace: 'gw:e2e', global_version_token: 'v-e2e' },
    });
    expect(putRes.ok()).toBeTruthy();
    const updated = (await putRes.json())['cache-settings'] as Record<string, unknown>;
    expect(updated['l2_enabled']).toBe(1);
    expect(updated['l2_provider']).toBe('redis');
    expect(updated['l1_ttl_ms']).toBe(15000);
    expect(updated['key_namespace']).toBe('gw:e2e');
    expect(updated['global_version_token']).toBe('v-e2e');

    // Restore defaults so we don't perturb other tests' server.
    await page.request.put('/api/admin/cache-settings', {
      headers,
      data: { l2_enabled: false, l2_provider: 'none', l1_ttl_ms: 30000, key_namespace: 'weave:cache', global_version_token: 'v1' },
    });
  });
});

// ─── 2 & 3. Real-LLM streaming cache ─────────────────────────

test.describe('Cache Phase 1 — real LLM streaming cache', () => {
  test.setTimeout(120_000);

  async function newDirectChat(page: Page, token: string): Promise<string> {
    const createRes = await page.request.post('/api/chats', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { title: 'Cache P1 Stream' },
    });
    expect(createRes.ok()).toBeTruthy();
    const { chat } = await createRes.json() as { chat: { id: string } };
    await page.request.post(`/api/chats/${chat.id}/settings`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { mode: 'direct', enabledTools: [] },
    });
    return chat.id;
  }

  async function stream(page: Page, token: string, chatId: string, content: string, temperature?: number) {
    const data: Record<string, unknown> = { content, stream: true, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 64 };
    if (temperature !== undefined) data['temperature'] = temperature;
    const res = await page.request.post(`/api/chats/${chatId}/messages`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data,
    });
    return parseDone(res);
  }

  test('identical deterministic prompts → second stream is a cache HIT', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newDirectChat(page, token);
    // Benign factual prompt (deterministic intent, no temperature) so no
    // injection guardrail fires and the answer is cacheable.
    const prompt = 'What is the capital of France? Answer in one short sentence.';

    const first = await parseDoneGuard(await stream(page, token, chatId, prompt));
    expect(first['cached'] ?? false).toBe(false); // cold miss → real LLM stream

    const second = await parseDoneGuard(await stream(page, token, chatId, prompt));
    expect(second['cached']).toBe(true);          // replayed from cache
  });

  test('streaming temperature > 0 is never cached (determinism gate)', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newDirectChat(page, token);
    const prompt = 'In one short sentence, invent a slogan for a bookshop.';

    const first = await parseDoneGuard(await stream(page, token, chatId, prompt, 0.8));
    expect(first['cached'] ?? false).toBe(false);

    const second = await parseDoneGuard(await stream(page, token, chatId, prompt, 0.8));
    expect(second['cached'] ?? false).toBe(false); // gate prevented the write → still a miss
  });
});

function parseDoneGuard(done: Record<string, unknown> | null): Record<string, unknown> {
  expect(done, 'no done event found in SSE stream').toBeTruthy();
  return done!;
}
