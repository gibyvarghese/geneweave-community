/**
 * Playwright E2E — Cache Phase 2 (provider-native prompt caching).
 *
 * 1. Admin model-pricing API round-trips the per-model prompt-cache policy.
 * 2. Real-LLM full path (OpenAI): a chat with a large, stable system prompt
 *    reports prompt-cache reads on a repeated turn — on BOTH the non-streaming
 *    (`stream:false` → result.promptCache) and streaming (`done.promptCache`)
 *    paths. Two DIFFERENT user messages share the cached system prefix, so the
 *    response cache (Phase 0) does not short-circuit the second LLM call.
 *
 * Uses a real model (OpenAI gpt-4o-mini) — no mock.
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';

const EMAIL = 'cache-phase2@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';

// ~20k chars ≈ 5k tokens — comfortably above OpenAI's 1024-token cache minimum
// and under the 32k system_prompt_max_chars limit.
const BIG_SYSTEM = (
  'You are geneWeave, an enterprise AI orchestration assistant. Follow these standing operating ' +
  'instructions precisely on every turn. '
).repeat(180);

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Cache P2', email: EMAIL, password: PASSWORD } });
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

// ─── 1. Admin model-pricing prompt-cache policy ──────────────

test.describe('Cache Phase 2 — admin model-pricing API', () => {
  test('seeded models expose the prompt-cache policy (cloud enabled, local disabled)', async ({ page }) => {
    await ensureLoggedIn(page);
    const listRes = await page.request.get('/api/admin/model-pricing');
    expect(listRes.ok()).toBeTruthy();
    const rows = (await listRes.json()).pricing as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(5);
    // Every seeded row carries the new columns.
    for (const r of rows) {
      expect(r).toHaveProperty('prompt_cache_enabled');
      expect(r).toHaveProperty('prompt_cache_min_tokens');
      expect(r).toHaveProperty('prompt_cache_ttl');
    }
    const cloud = rows.filter(r => ['anthropic', 'openai', 'google'].includes(String(r['provider'])));
    const local = rows.filter(r => ['ollama', 'llamacpp'].includes(String(r['provider'])));
    expect(cloud.length).toBeGreaterThan(0);
    expect(cloud.every(r => r['prompt_cache_enabled'] === 1)).toBe(true);
    if (local.length > 0) expect(local.every(r => r['prompt_cache_enabled'] === 0)).toBe(true);
  });

  test('round-trips the per-model prompt-cache policy', async ({ page }) => {
    await ensureLoggedIn(page);
    const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

    const created = await page.request.post('/api/admin/model-pricing', {
      headers,
      data: { model_id: 'claude-e2e-test', provider: 'anthropic', input_cost_per_1m: 3, output_cost_per_1m: 15, enabled: true },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()).pricing as Record<string, unknown>)['id'] as string;
    // New rows get the secure defaults.
    const fresh = (await created.json()).pricing as Record<string, unknown>;
    expect(fresh['prompt_cache_enabled']).toBe(1);
    expect(fresh['prompt_cache_min_tokens']).toBe(1024);
    expect(fresh['prompt_cache_ttl']).toBe('5m');

    const put = await page.request.put(`/api/admin/model-pricing/${id}`, {
      headers,
      data: { prompt_cache_enabled: false, prompt_cache_min_tokens: 2048, prompt_cache_ttl: '1h' },
    });
    expect(put.ok()).toBeTruthy();
    const updated = (await put.json()).pricing as Record<string, unknown>;
    expect(updated['prompt_cache_enabled']).toBe(0);
    expect(updated['prompt_cache_min_tokens']).toBe(2048);
    expect(updated['prompt_cache_ttl']).toBe('1h');

    await page.request.delete(`/api/admin/model-pricing/${id}`, { headers });
  });
});

// ─── 2. Real-LLM full-path prompt caching ────────────────────

test.describe('Cache Phase 2 — real LLM prompt caching (full path)', () => {
  test.setTimeout(120_000);

  async function newBigPromptChat(page: Page, token: string): Promise<string> {
    const createRes = await page.request.post('/api/chats', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { title: 'Cache P2 Prompt Cache' },
    });
    expect(createRes.ok()).toBeTruthy();
    const { chat } = await createRes.json() as { chat: { id: string } };
    const settings = await page.request.post(`/api/chats/${chat.id}/settings`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { mode: 'direct', enabledTools: [], systemPrompt: BIG_SYSTEM },
    });
    expect(settings.ok(), `settings failed: ${settings.status()} ${await settings.text().catch(() => '')}`).toBeTruthy();
    return chat.id;
  }

  async function sendNonStream(page: Page, token: string, chatId: string, content: string) {
    const res = await page.request.post(`/api/chats/${chatId}/messages`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 16 },
    });
    expect(res.ok(), `send failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    return await res.json() as { promptCache?: { readTokens: number; writeTokens: number; applied: boolean } };
  }

  async function streamDone(res: APIResponse): Promise<Record<string, unknown> | null> {
    expect(res.ok(), `stream failed: ${res.status()}`).toBeTruthy();
    let done: Record<string, unknown> | null = null;
    for (const line of (await res.text()).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { const e = JSON.parse(t.slice(5).trim()) as Record<string, unknown>; if (e['type'] === 'done') done = e; } catch { /* */ }
    }
    return done;
  }

  // Benign, distinct questions that share the big stable system prefix but
  // differ from each other (so the response cache never short-circuits) and do
  // not trip the injection guardrail.
  const QUESTIONS = [
    'What is the capital of France?',
    'What is the capital of Japan?',
    'What is the capital of Italy?',
    'What is the capital of Spain?',
    'What is the capital of Brazil?',
  ];

  test('non-streaming: a repeated stable prefix reports prompt-cache reads', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newBigPromptChat(page, token);

    // Prime, then read with DIFFERENT benign turns. OpenAI prompt caching is
    // best-effort, so warm up over a few turns until a read registers; the
    // assertion still strictly requires a prompt-cache read.
    let applied = false;
    let maxRead = 0;
    for (const q of QUESTIONS) {
      const r = await sendNonStream(page, token, chatId, q);
      applied = applied || (r.promptCache?.applied ?? false);
      maxRead = Math.max(maxRead, r.promptCache?.readTokens ?? 0);
      if (maxRead > 0) break;
    }
    expect(applied).toBe(true);
    expect(maxRead).toBeGreaterThan(0);
  });

  test('streaming: a repeated stable prefix reports prompt-cache reads in done.promptCache', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newBigPromptChat(page, token);

    const stream = (content: string) => page.request.post(`/api/chats/${chatId}/messages`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { content, stream: true, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 16 },
    });

    // Prime + warm up over a few benign turns (OpenAI caching is best-effort).
    let applied = false;
    let maxRead = 0;
    for (const q of QUESTIONS) {
      const done = await streamDone(await stream(q));
      const pc = done?.['promptCache'] as { readTokens: number; applied: boolean } | undefined;
      applied = applied || (pc?.applied ?? false);
      maxRead = Math.max(maxRead, pc?.readTokens ?? 0);
      if (maxRead > 0) break;
    }
    expect(applied).toBe(true);
    expect(maxRead).toBeGreaterThan(0);
  });
});
