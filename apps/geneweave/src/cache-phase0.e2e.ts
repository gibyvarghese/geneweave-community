/**
 * Playwright E2E — Cache Phase 0 hardening
 *
 * 1. Admin cache-policies CRUD exercises the new Phase 0 fields through the live
 *    server (routes → db → m82 migration): max_bytes, key_hashing,
 *    tenant_isolation, cache_temperature_gate, output_bypass_patterns.
 * 2. Admin UI renders the new policy fields.
 * 3. Real-LLM behaviour through the non-streaming chat endpoint:
 *      - identical deterministic (temperature 0) prompts → second is a cache HIT;
 *      - temperature > 0 prompts → never cached (determinism gate).
 *
 * Uses a real model (OpenAI gpt-4o-mini) — no mock — per the caching requirement.
 */

import { test, expect, type Page } from '@playwright/test';

const EMAIL = 'cache-phase0@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const LLM_PROVIDER = process.env['CACHE_E2E_PROVIDER'] ?? 'openai';
const LLM_MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Cache P0', email: EMAIL, password: PASSWORD } });
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

// ─── 1. Admin cache-policies CRUD with the new Phase 0 fields ─────────────────

test.describe('Cache Phase 0 — admin API', () => {
  test('CRUD round-trips the new hardening fields', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const headers = { 'x-csrf-token': token, 'content-type': 'application/json' };

    // Seeded list includes the new columns
    const listRes = await page.request.get('/api/admin/cache-policies');
    expect(listRes.ok()).toBeTruthy();
    const list = (await listRes.json())['cache-policies'] as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('key_hashing');
    expect(list[0]).toHaveProperty('tenant_isolation');
    expect(list[0]).toHaveProperty('cache_temperature_gate');
    expect(list[0]).toHaveProperty('output_bypass_patterns');

    // Create with the new fields
    const createRes = await page.request.post('/api/admin/cache-policies', {
      headers,
      data: {
        name: 'E2E Phase0 Policy',
        scope: 'tenant',
        ttl_ms: 30000,
        max_entries: 250,
        max_bytes: 65536,
        key_hashing: 'sha256',
        tenant_isolation: true,
        cache_temperature_gate: 0,
        bypass_patterns: ['password'],
        output_bypass_patterns: ['sk-[A-Za-z0-9]{16,}'],
        enabled: true,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json())['cache-policy'] as Record<string, unknown>;
    const id = created['id'] as string;
    expect(created['max_bytes']).toBe(65536);
    expect(created['key_hashing']).toBe('sha256');
    expect(created['tenant_isolation']).toBe(1);

    // Update the hardening fields
    const putRes = await page.request.put(`/api/admin/cache-policies/${id}`, {
      headers,
      data: { tenant_isolation: false, cache_temperature_gate: 1, key_hashing: 'none' },
    });
    expect(putRes.ok()).toBeTruthy();
    const updated = (await putRes.json())['cache-policy'] as Record<string, unknown>;
    expect(updated['tenant_isolation']).toBe(0);
    expect(updated['cache_temperature_gate']).toBe(1);
    expect(updated['key_hashing']).toBe('none');

    // Clean up
    const delRes = await page.request.delete(`/api/admin/cache-policies/${id}`, { headers });
    expect(delRes.ok()).toBeTruthy();
  });
});

// ─── 2. Admin UI renders the new fields ──────────────────────────────────────

test.describe('Cache Phase 0 — admin UI', () => {
  test('cache-policies form shows the new hardening fields', async ({ page }) => {
    await ensureLoggedIn(page);
    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Admin' }).click();
    await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });

    // Open the admin nav and locate the cache-policies tab, expanding groups as needed.
    const adminMenu = page.locator('.admin-nav-sub');
    if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click();
      await expect(adminMenu).toBeVisible({ timeout: 5000 });
    }
    const tab = page.locator('[data-admin-tab="cache-policies"]').first();
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

    // Open the "New" form and assert the new field labels render.
    const main = page.locator('.main');
    await main.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ }).click();
    await expect(main.getByText('Tenant Isolation', { exact: false })).toBeVisible({ timeout: 5000 });
    await expect(main.getByText(/Temperature Gate/i)).toBeVisible();
    await expect(main.getByText(/Key Hashing/i)).toBeVisible();
    await expect(main.getByText(/response \(JSON\)/i)).toBeVisible();
  });
});

// ─── 3. Real-LLM caching behaviour (non-streaming endpoint) ───────────────────

test.describe('Cache Phase 0 — real LLM caching', () => {
  test.setTimeout(120_000);

  async function newDirectChat(page: Page, token: string): Promise<string> {
    const createRes = await page.request.post('/api/chats', {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { title: 'Cache P0 LLM' },
    });
    expect(createRes.ok()).toBeTruthy();
    const { chat } = await createRes.json() as { chat: { id: string } };
    // Direct mode → single deterministic model call → cleanly cacheable.
    await page.request.post(`/api/chats/${chat.id}/settings`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data: { mode: 'direct', enabledTools: [] },
    });
    return chat.id;
  }

  async function send(page: Page, token: string, chatId: string, content: string, temperature?: number) {
    // Omit `temperature` when undefined: the determinism gate treats an unset
    // temperature as deterministic (cacheable), and we avoid sending
    // `temperature: 0`, which some current OpenAI models reject.
    const data: Record<string, unknown> = { content, stream: false, provider: LLM_PROVIDER, model: LLM_MODEL, maxTokens: 64 };
    if (temperature !== undefined) data['temperature'] = temperature;
    const res = await page.request.post(`/api/chats/${chatId}/messages`, {
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      data,
    });
    expect(res.ok(), `send failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    return await res.json() as { assistantContent: string; cached?: boolean };
  }

  test('identical deterministic prompts → second is a cache HIT', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newDirectChat(page, token);
    const prompt = 'Reply with exactly the single word: PONG';

    const first = await send(page, token, chatId, prompt); // deterministic (temperature unset)
    expect(first.cached ?? false).toBe(false); // cold miss → real LLM

    const second = await send(page, token, chatId, prompt);
    expect(second.cached).toBe(true);          // served from cache
    expect(second.assistantContent).toBe(first.assistantContent);
  });

  test('temperature > 0 prompts are never cached (determinism gate)', async ({ page }) => {
    await ensureLoggedIn(page);
    const token = await csrf(page);
    const chatId = await newDirectChat(page, token);
    // Unique prompt (temperature is not part of the key) so this can't hit the
    // temperature-0 entry from the other test.
    const prompt = 'In one short sentence, suggest a creative name for a coffee shop.';

    const first = await send(page, token, chatId, prompt, 0.8);
    expect(first.cached ?? false).toBe(false);

    const second = await send(page, token, chatId, prompt, 0.8);
    expect(second.cached ?? false).toBe(false); // gate prevented the write → still a miss
  });
});
