/**
 * Playwright E2E — Answer feedback + AI transparency (m137). Proves the acceptance bar:
 *   • API round-trip: submit a thumbs-down with a tiered reason + comment → it comes back on GET my-feedback.
 *   • Negative/security: an invalid signal is rejected; junk / injection-y reason keys are dropped (sanitised).
 *   • Extends the EXISTING signal: the same submission lands in the admin Answer-Feedback list (with reasons).
 *   • AI transparency: an admin toggles the "AI-generated" label + disclosure wording + turns feedback off;
 *     /api/me/ai-transparency reflects it (the config the chat UI applies).
 *   • Agent-facing aggregate: /api/admin/answer-feedback/summary reports totals + top down-vote reasons.
 *   • UI: after an answer streams, the "AI-generated" disclosure shows, a 👎 opens the reason panel, picking a
 *     reason + sending shows "Thanks — noted" (screenshots reviewed vs the design language).
 * Run: npm run test:e2e -- answer-feedback   (the API tests need no LLM; the UI test uses the default model).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'afb-owner@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
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
  return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';
}

/** Create a chat, send one message, and return { chatId, assistantMessageId }. */
async function chatWithOneAnswer(page: Page, origin: string, hdr: Record<string, string>): Promise<{ chatId: string; messageId: string }> {
  const created = await (await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Feedback test' } })).json() as { chat: { id: string } };
  const chatId = created.chat.id;
  // Kick off a stream and consume it to completion (works with any provider, incl. mock).
  const stream = await page.request.post(`${origin}/api/chats/${chatId}/messages/stream`, { headers: hdr, data: { content: 'Say hello in one short sentence.' } });
  await stream.body();
  // Grab the assistant message id.
  const msgs = await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; role: string }> };
  const assistant = [...msgs.messages].reverse().find((m) => m.role === 'assistant');
  expect(assistant, 'an assistant message should exist').toBeTruthy();
  return { chatId, messageId: assistant!.id };
}

// ── API: submit feedback (thumbs + tiered reason + comment) round-trips ────────────────
test('Answer feedback — API round-trip, negative + security, admin visibility, aggregate', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const { chatId, messageId } = await chatWithOneAnswer(page, origin, hdr);

  // POSITIVE: a thumbs-down with two known reasons + a comment.
  const sub = await page.request.post(`${origin}/api/messages/${messageId}/feedback`, {
    headers: hdr,
    data: { signal: 'thumbs_down', chatId, categories: ['inaccurate', 'incomplete'], comment: 'Missed the key point.' },
  });
  expect(sub.status()).toBe(201);

  // It comes back on my-feedback with the reasons preserved.
  const mine = await (await page.request.get(`${origin}/api/me/chats/${chatId}/feedback`)).json() as { feedback: Record<string, { signal: string; categories: string[]; comment: string | null }> };
  expect(mine.feedback[messageId]!.signal).toBe('thumbs_down');
  expect(mine.feedback[messageId]!.categories.sort()).toEqual(['inaccurate', 'incomplete']);
  expect(mine.feedback[messageId]!.comment).toContain('key point');

  // NEGATIVE: an invalid signal is rejected.
  const bad = await page.request.post(`${origin}/api/messages/${messageId}/feedback`, { headers: hdr, data: { signal: 'nope', chatId } });
  expect(bad.status()).toBe(400);

  // SECURITY: junk / injection-y reason keys are dropped (only known keys survive).
  const inj = await page.request.post(`${origin}/api/messages/${messageId}/feedback`, {
    headers: hdr,
    data: { signal: 'thumbs_down', chatId, categories: ['<script>alert(1)</script>', "'; DROP TABLE message_feedback;--", 'unsafe'] },
  });
  expect(inj.status()).toBe(201);
  const mine2 = await (await page.request.get(`${origin}/api/me/chats/${chatId}/feedback`)).json() as { feedback: Record<string, { categories: string[] }> };
  expect(mine2.feedback[messageId]!.categories).toEqual(['unsafe']); // the two junk entries dropped

  // ADMIN visibility: the same feedback shows in the admin Answer-Feedback list, carrying the reasons column.
  const adminList = await (await page.request.get(`${origin}/api/admin/message-feedback?limit=50`)).json() as { feedback: Array<{ message_id: string; signal: string; categories: string | null }> };
  const forMsg = adminList.feedback.filter((f) => f.message_id === messageId); // feedback appends → several rows
  expect(forMsg.length).toBeGreaterThanOrEqual(1);
  expect(forMsg.every((f) => f.signal === 'thumbs_down')).toBe(true);
  expect(forMsg.some((f) => String(f.categories ?? '').includes('unsafe'))).toBe(true);

  // AGGREGATE (the shape the review_answer_feedback agent tool returns): totals + ranked reasons.
  const summary = await (await page.request.get(`${origin}/api/admin/answer-feedback/summary`)).json() as { summary: { total: number; down: number; topCategories: Array<{ key: string; count: number }> } };
  expect(summary.summary.total).toBeGreaterThanOrEqual(1);
  expect(summary.summary.down).toBeGreaterThanOrEqual(1);
  expect(summary.summary.topCategories.length).toBeGreaterThanOrEqual(1);
});

// ── AI transparency: admin config drives what the client discloses ─────────────────────
test('AI transparency — admin config round-trips and drives /api/me/ai-transparency', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Default: label on, feedback on.
  const def = await (await page.request.get(`${origin}/api/me/ai-transparency`)).json() as { showAiLabel: boolean; feedbackEnabled: boolean; categories: unknown[] };
  expect(def.showAiLabel).toBe(true);
  expect(Array.isArray(def.categories)).toBe(true);
  expect(def.categories.length).toBeGreaterThan(0);

  // Admin changes the disclosure wording + turns the label + feedback OFF.
  const put = await page.request.put(`${origin}/api/admin/ai-transparency/default`, {
    headers: hdr,
    data: { show_ai_label: 0, feedback_enabled: 0, disclosure_text: 'Made by AI — please double-check.' },
  });
  expect(put.status()).toBe(200);

  const after = await (await page.request.get(`${origin}/api/me/ai-transparency`)).json() as { showAiLabel: boolean; feedbackEnabled: boolean; disclosureText: string };
  expect(after.showAiLabel).toBe(false);
  expect(after.feedbackEnabled).toBe(false);
  expect(after.disclosureText).toContain('double-check');

  // Restore defaults so the UI test below sees the label + feedback.
  await page.request.put(`${origin}/api/admin/ai-transparency/default`, {
    headers: hdr,
    data: { show_ai_label: 1, feedback_enabled: 1, disclosure_text: 'AI-generated — may be inaccurate. Check anything important.' },
  });
});

// ── UI: disclosure shows + 👎 → reason panel → "Thanks — noted" ────────────────────────
test('Answer feedback — UI: disclosure + thumbs-down reason flow (screenshots)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  const { chatId } = await chatWithOneAnswer(page, origin, hdr);

  // Open the chat in the UI.
  await page.evaluate(async (id: string) => {
    const win = window as unknown as { selectChat?: (id: string) => Promise<void>; state?: { view: string; currentChatId: string | null }; render?: () => void };
    if (win.state) { win.state.view = 'chat'; win.state.currentChatId = id; }
    if (win.render) win.render();
    if (win.selectChat) await win.selectChat(id);
  }, chatId);

  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant).toBeVisible({ timeout: 15000 });
  // The AI-generated disclosure is shown under the answer.
  await expect(assistant.locator('.ai-disclosure')).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: '/tmp/pw-afb-disclosure.png' });

  // Hover to reveal the toolbar, then click 👎.
  await assistant.hover();
  const downBtn = assistant.locator('.fb-btn[aria-label="Needs work"]');
  await expect(downBtn).toBeVisible({ timeout: 8000 });
  await downBtn.click();

  // The reason panel opens; pick a reason + send.
  const panel = assistant.locator('.fb-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: '/tmp/pw-afb-reason-panel.png' });
  await panel.locator('.fb-chip', { hasText: 'Incomplete' }).click();
  await panel.locator('.fb-comment').fill('Could go deeper.');
  await panel.locator('.fb-send').click();

  // Confirmation appears.
  await expect(assistant.locator('.fb-thanks')).toBeVisible({ timeout: 8000 });
  await expect(assistant.locator('.fb-btn.fb-on[aria-label="Needs work"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/pw-afb-thanks.png' });
});
