/**
 * UX Audit — Round 2: state completeness & DIFFERENTIATED errors.
 * The chat send/stream (`sendMessage` in ui-client.ts) is the primary async surface. Round 1 (FP-C) showed
 * the app collapses all failures into `Error: <technical>` with no recovery. Here we force the four distinct
 * failure modes and require distinct, human messaging + a matching recovery — and a refusal that does NOT
 * read like a system error. Plus: empty state renders + user input is preserved on failure.
 *
 * Run: npm run test:e2e -- audit-round2
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';

async function login(page: Page): Promise<void> {
  const email = `audit2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@weaveintel.dev`;
  await page.request.post('/api/auth/register', { data: { name: 'Audit Two', email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

async function openFreshChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: /new chat/i }).first().click();
  await expect(page.locator('textarea[placeholder="Type a message..."]')).toBeVisible();
}

async function typeAndSend(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea[placeholder="Type a message..."]');
  await ta.click();
  await ta.fill(text);
  await page.getByRole('button', { name: /^send/i }).click();
}

test.describe('Round 2 — differentiated errors + state completeness', () => {
  test('EMPTY — a new chat shows a non-blank guiding empty state', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await expect(page.locator('.empty-chat')).toBeVisible();
    await expect(page.locator('.empty-chat')).not.toBeEmpty();
  });

  test('NETWORK DROP — reads as a connection problem (not a raw fetch error) + offers Retry', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await typeAndSend(page, 'hello there');
    // The user's message is preserved in the transcript (input not lost).
    await expect(page.locator('.message.user, .msg-user, .messages').getByText('hello there').first()).toBeVisible();
    // The error is human + connection-specific, and a Retry recovery exists.
    const err = page.locator('.msg-error').first();
    await expect(err).toBeVisible({ timeout: 10000 });
    await expect(err).toContainText(/connection|reach|offline|network/i);
    await expect(err).not.toContainText(/failed to fetch|TypeError/i);
    await expect(page.getByRole('button', { name: /try again|retry/i })).toBeVisible();
  });

  test('RATE LIMIT (429) — distinct "busy, try again shortly" messaging', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', message: 'Too many requests' }) })
      : route.continue());
    await typeAndSend(page, 'ping');
    const err = page.locator('.msg-error').first();
    await expect(err).toBeVisible({ timeout: 10000 });
    await expect(err).toContainText(/busy|moment|shortly|rate|too many|try again/i);
    await expect(page.getByRole('button', { name: /try again|retry/i })).toBeVisible();
  });

  test('SERVER ERROR (500) — distinct "something went wrong on our end" messaging', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'boom' }) })
      : route.continue());
    await typeAndSend(page, 'ping');
    const err = page.locator('.msg-error').first();
    await expect(err).toBeVisible({ timeout: 10000 });
    await expect(err).toContainText(/went wrong|our end|our side|server|something broke/i);
    await expect(err).not.toContainText(/Streaming request failed \(500\)/);
  });

  test('CONTENT-POLICY REFUSAL — reads as a declined request, NOT a system error', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'content_policy', message: 'This request was declined by the safety policy.' }) })
      : route.continue());
    await typeAndSend(page, 'do something disallowed');
    // A refusal is its OWN calm state, not the red system-error block.
    const refusal = page.locator('.msg-refusal').first();
    await expect(refusal).toBeVisible({ timeout: 10000 });
    await expect(refusal).toContainText(/declined|can.t help|safety|policy|not able/i);
    await expect(page.locator('.msg-error')).toHaveCount(0);      // not styled as a broken/system error
    await expect(refusal).not.toContainText(/Error:|failed \(403\)/i);
  });

  const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

  test('VISUAL — capture the differentiated error + refusal states for review', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await typeAndSend(page, 'take a screenshot of the network error');
    await expect(page.locator('.msg-error').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SHOT}/round2-error-network.png` });
    await page.unroute('**/api/chats/*/messages');
    await openFreshChat(page);
    await page.route('**/api/chats/*/messages', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'content_policy', message: 'geneWeave declined this request under its safety policy. You can rephrase and try a different approach.' }) })
      : route.continue());
    await typeAndSend(page, 'something disallowed');
    await expect(page.locator('.msg-refusal').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SHOT}/round2-refusal.png` });
  });

  test('REAL LLM — the happy path still streams a real answer (no error block) after the refactor', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await openFreshChat(page);
    await typeAndSend(page, 'Reply with exactly the three words: pixel perfect audit');
    // Wait for streaming to finish (send button re-enables).
    await expect(page.locator('.send-btn[aria-disabled="false"]')).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(400);
    // A real assistant answer rendered, and NO failure UI.
    await expect(page.locator('.msg.assistant .bubble').last()).not.toBeEmpty();
    await expect(page.locator('.msg-error')).toHaveCount(0);
    await expect(page.locator('.msg-refusal')).toHaveCount(0);
  });

  test('RETRY — the recovery action re-sends the failed message', async ({ page }) => {
    await login(page);
    await openFreshChat(page);
    let posts = 0;
    await page.route('**/api/chats/*/messages', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal' }) });
    });
    await typeAndSend(page, 'retry me');
    await expect(page.locator('.msg-error').first()).toBeVisible({ timeout: 10000 });
    expect(posts).toBe(1);
    await page.getByRole('button', { name: /try again|retry/i }).click();
    await expect.poll(() => posts, { timeout: 8000 }).toBe(2);
  });
});
