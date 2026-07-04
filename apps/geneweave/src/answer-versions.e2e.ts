// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Regenerate an answer, keeping version history (m139). Real managed server + real LLM.
 *
 * Proves the acceptance bar:
 *   • Config + admin round-trip: GET my config; an admin PUT changes enabled/max-versions; GET reflects.
 *   • Regenerate keeps history (real LLM): a fresh alternative is created, the OLD answer is preserved as
 *     version 1, the new one is active (2/2); regenerating again → 3/3; selecting version 1 restores it
 *     losslessly (the live transcript message mirrors the active version).
 *   • Validation/security: unknown message → 404; a user turn can't be regenerated → 400; another user can't
 *     regenerate/select on my chat.
 *   • UI: a settled answer offers ↻ Regenerate; using it shows a ‹ 2/2 › pager; paging swaps the shown text.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- answer-versions
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'av-owner@weaveintel.dev';
const OTHER = 'av-other@weaveintel.dev';

async function login(page: Page, email: string): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}

/** Create a chat, send one message (real stream), return { chatId, assistantMessageId, originalContent }. */
async function chatWithOneAnswer(page: Page, origin: string, H: Record<string, string>): Promise<{ chatId: string; messageId: string; original: string }> {
  const chatId = (await (await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Regenerate test' } })).json() as { chat: { id: string } }).chat.id;
  const stream = await page.request.post(`${origin}/api/chats/${chatId}/messages/stream`, { headers: H, data: { content: 'In one short sentence, what is a good reason to keep a journal?' } });
  await stream.body();
  const msgs = await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; role: string; content: string }> };
  const assistant = [...msgs.messages].reverse().find((m) => m.role === 'assistant')!;
  return { chatId, messageId: assistant.id, original: assistant.content };
}

type VerResp = { messageId?: string; content: string; variants: Array<{ id: string; content: string; reason: string | null }>; activeIndex: number; label: { index: number; total: number; text: string; show: boolean } };

// ── Config + admin + validation + isolation (deterministic) ───────────────────────────
test('Answer versions — config, admin round-trip, validation, cross-user isolation', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { origin, H } = await login(page, OWNER);

  const cfg = await (await page.request.get(`${origin}/api/me/answer-versions`)).json() as { enabled: boolean; maxVariants: number };
  expect(cfg.enabled).toBe(true);

  const put = await page.request.put(`${origin}/api/admin/answer-versions/default`, { headers: H, data: { enabled: 1, max_variants: 4 } });
  expect(put.status()).toBe(200);
  const got = await (await page.request.get(`${origin}/api/admin/answer-versions/default`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['max_variants']).toBe(4);
  await page.request.put(`${origin}/api/admin/answer-versions/default`, { headers: H, data: { enabled: 1, max_variants: 5 } });

  const { chatId, messageId } = await chatWithOneAnswer(page, origin, H);
  // VALIDATION: unknown message → 404; regenerating a USER message → 400.
  expect((await page.request.post(`${origin}/api/me/chats/${chatId}/messages/nope/regenerate`, { headers: H })).status()).toBe(404);
  const userMsgId = (await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; role: string }> }).messages.find((m) => m.role === 'user')!.id;
  expect((await page.request.post(`${origin}/api/me/chats/${chatId}/messages/${userMsgId}/regenerate`, { headers: H })).status()).toBe(400);

  // ISOLATION: another user cannot regenerate / select on the owner's chat.
  const other = await browser.newPage();
  const o = await login(other, OTHER);
  expect((await other.request.post(`${o.origin}/api/me/chats/${chatId}/messages/${messageId}/regenerate`, { headers: o.H })).status()).toBe(404);
  expect((await other.request.post(`${o.origin}/api/me/chats/${chatId}/messages/${messageId}/select-version`, { headers: o.H, data: { index: 0 } })).status()).toBe(404);
  await other.close();
});

// ── Regenerate keeps history + lossless switching (real LLM) ───────────────────────────
test('Answer versions — regenerate preserves the old answer; selecting a version restores it', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page, OWNER);
  const { chatId, messageId, original } = await chatWithOneAnswer(page, origin, H);
  expect(original.length).toBeGreaterThan(0);

  // Regenerate → 2 versions, the new one active; the original is preserved as version 1.
  const r1 = await (await page.request.post(`${origin}/api/me/chats/${chatId}/messages/${messageId}/regenerate`, { headers: H })).json() as VerResp;
  // eslint-disable-next-line no-console
  console.log('[regen] original:', original.slice(0, 60), '\n[regen] v2:', r1.content.slice(0, 60));
  expect(r1.variants.length).toBe(2);
  expect(r1.variants[0]!.reason).toBe('original');
  expect(r1.variants[0]!.content).toBe(original);      // the OLD answer is kept, verbatim
  expect(r1.variants[1]!.reason).toBe('regenerate');
  expect(r1.activeIndex).toBe(1);
  expect(r1.label.text).toBe('2/2');
  expect(r1.content.length).toBeGreaterThan(0);

  // The live transcript message now mirrors the active (regenerated) version.
  const afterRegen = (await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; content: string }> }).messages.find((m) => m.id === messageId)!;
  expect(afterRegen.content).toBe(r1.content);

  // Regenerate again → 3 versions.
  const r2 = await (await page.request.post(`${origin}/api/me/chats/${chatId}/messages/${messageId}/regenerate`, { headers: H })).json() as VerResp;
  expect(r2.variants.length).toBe(3);
  expect(r2.label.text).toBe('3/3');

  // Select version 1 (the original) → the transcript message reverts to it, losslessly.
  const sel = await (await page.request.post(`${origin}/api/me/chats/${chatId}/messages/${messageId}/select-version`, { headers: H, data: { index: 0 } })).json() as VerResp;
  expect(sel.content).toBe(original);
  const reverted = (await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; content: string }> }).messages.find((m) => m.id === messageId)!;
  expect(reverted.content).toBe(original);

  // Versions still lists all three (nothing lost by switching).
  const list = await (await page.request.get(`${origin}/api/me/chats/${chatId}/messages/${messageId}/versions`)).json() as VerResp;
  expect(list.variants.length).toBe(3);
  expect(list.activeIndex).toBe(0);
});

// ── UI: ↻ Regenerate → ‹ 2/2 › pager → paging swaps the text (real LLM, screenshots) ───
test('Answer versions — UI regenerate shows a version pager and swaps the shown answer', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page, OWNER);
  const { chatId } = await chatWithOneAnswer(page, origin, H);

  await page.evaluate(async (id: string) => {
    const win = window as unknown as { selectChat?: (id: string) => Promise<void>; state?: { view: string; currentChatId: string | null }; render?: () => void };
    if (win.state) { win.state.view = 'chat'; win.state.currentChatId = id; }
    win.render?.();
    if (win.selectChat) await win.selectChat(id);
  }, chatId);

  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant).toBeVisible({ timeout: 15000 });
  await assistant.hover();
  const regen = assistant.locator('.ver-regen');
  await expect(regen).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: '/tmp/pw-av-before.png' });

  const before = (await assistant.locator('.bubble').first().textContent()) ?? '';
  await regen.click();

  // The pager appears at 2/2 once the alternative is ready.
  await expect(assistant.locator('.ver-count')).toHaveText('2/2', { timeout: 60_000 });
  await page.screenshot({ path: '/tmp/pw-av-regenerated.png', fullPage: true });

  // Page back to version 1 — the shown text returns to the original.
  await assistant.hover();
  await assistant.locator('.ver-nav[aria-label="Previous version"]').click();
  await expect(assistant.locator('.ver-count')).toHaveText('1/2', { timeout: 8000 });
  await expect.poll(async () => (await assistant.locator('.bubble').first().textContent()) ?? '', { timeout: 8000 }).toBe(before);
  await page.screenshot({ path: '/tmp/pw-av-paged-back.png' });
});
