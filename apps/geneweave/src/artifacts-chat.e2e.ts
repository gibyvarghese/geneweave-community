/**
 * Playwright E2E: Phase 7 via Chat UI
 *
 * Tests the full end-to-end artifact workflow through the geneWeave chat:
 *   1. Log in, create a chat with emit_artifact enabled in settings
 *   2. Ask gpt-4o-mini to emit a markdown artifact
 *   3. Wait for the artifact card to appear in the chat
 *   4. Click the card → preview modal → Phase 7 buttons (Share, Embed, Download)
 *   5. Visit the public share URL anonymously
 */

import { test, expect, type Page } from '@playwright/test';

const TEST_EMAIL    = 'chat-phase7@weaveintel.dev';
const TEST_PASSWORD = 'Str0ng!Pass99';

// ─── Auth / CSRF ──────────────────────────────────────────────────────────────

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', {
      data: { name: 'Chat Phase7', email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    res = await page.request.post('/api/auth/login', {
      data: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

async function getCsrfToken(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

// ─── Chat setup ───────────────────────────────────────────────────────────────

/**
 * Create a fresh chat with emit_artifact enabled, navigate to it, and return its ID.
 * Using the settings API to pre-enable emit_artifact before sending any messages.
 */
async function createArtifactChat(page: Page): Promise<string> {
  const csrf = await getCsrfToken(page);

  // Create a new chat
  const createRes = await page.request.post('/api/chats', {
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
    data: { title: 'Phase7 Artifact Test' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { chat } = await createRes.json() as { chat: { id: string } };
  const chatId = chat.id;

  // Enable emit_artifact in this chat's settings
  const settingsRes = await page.request.post(`/api/chats/${chatId}/settings`, {
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
    data: {
      mode: 'agent',
      enabledTools: [
        'emit_artifact',
        'datetime', 'calculator', 'json_format', 'text_analysis',
        'memory_recall', 'memory_search', 'memory_remember',
      ],
    },
  });
  expect(settingsRes.ok()).toBeTruthy();

  return chatId;
}

/** Navigate to a specific chat using the globally-exposed state/selectChat (ui-client.ts:1972-1975). */
async function navigateToChat(page: Page, chatId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const win = window as unknown as {
      selectChat?: (id: string) => Promise<void>;
      state?: { view: string; currentChatId: string | null };
      render?: () => void;
    };
    // Ensure we're in the chat view
    if (win.state) { win.state.view = 'chat'; win.state.currentChatId = id; }
    if (win.render) win.render();
    // selectChat fetches messages and re-renders with the correct chat
    if (win.selectChat) await win.selectChat(id);
  }, chatId);
  // Ensure the chat input is visible
  await expect(page.locator('textarea[placeholder="Type a message..."]')).toBeVisible({ timeout: 8000 });
}

/** Send a message in the currently open chat. */
async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea[placeholder="Type a message..."]');
  await expect(textarea).toBeVisible({ timeout: 8000 });
  await textarea.click();
  await textarea.fill(text);
  await page.locator('.send-btn').click();
}

/** Wait for streaming to finish AND for at least one artifact card to appear. */
async function waitForArtifactCard(page: Page, timeoutMs = 90000): Promise<void> {
  // Wait for the send button to re-enable (streaming done)
  await expect(page.locator('.send-btn[aria-disabled="false"]')).toBeVisible({ timeout: timeoutMs });
  // Give a brief moment for the card to render
  await page.waitForTimeout(500);
  await expect(page.locator('.artifact-card').first()).toBeVisible({ timeout: 15000 });
}

// ─── Send message directly via API then reload UI ─────────────────────────────

/**
 * Alternative approach: use the streaming API directly to trigger artifact emission,
 * then reload the page to see the artifact card in the UI.
 */
async function sendMessageViaApi(page: Page, chatId: string, text: string): Promise<void> {
  const csrf = await getCsrfToken(page);
  // Kick off stream — we don't need to consume it, just trigger the agent run
  // The server will persist the artifact to the DB regardless
  page.request.post(`/api/chats/${chatId}/messages/stream`, {
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
    data: { content: text },
  }).catch(() => {}); // stream response — ignore

  // Wait for the typing indicator / streaming to start in the UI
  await page.waitForTimeout(2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Phase 7 via Chat UI — geneWeave chat with emit_artifact', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await ensureLoggedIn(page);
  });

  test('Chat: gpt-4o-mini emits artifact → Phase 7 buttons appear in preview modal', async ({ page }) => {
    // ── 1. Create chat with emit_artifact enabled ─────────────────────────────
    const chatId = await createArtifactChat(page);
    console.log('[chat test] chatId:', chatId);

    // ── 2. Navigate to the chat ────────────────────────────────────────────────
    await navigateToChat(page, chatId);
    await page.screenshot({ path: '/tmp/pw-chat-ready.png' });

    // ── 3. Ask the AI to emit a markdown artifact ─────────────────────────────
    await sendMessage(
      page,
      'Please use the emit_artifact tool to save a markdown artifact named "phase7-demo.md" ' +
      'with this content:\n\n# Phase 7 Demo\n\nThis tests Export, Share & Embed in geneWeave.\n\n- Share: creates a signed public URL\n- Embed: generates an iframe code snippet\n- Download: typed attachment with correct MIME type',
    );

    // ── 4. Wait for artifact card ─────────────────────────────────────────────
    await waitForArtifactCard(page);
    await page.screenshot({ path: '/tmp/pw-chat-artifact-card.png' });

    const card = page.locator('.artifact-card').first();
    await expect(card).toBeVisible();
    console.log('[chat test] card text:', (await card.textContent())?.slice(0, 60));

    // ── 5. Click card → preview modal ─────────────────────────────────────────
    await card.click();
    await expect(page.locator('#artifact-preview-overlay')).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: '/tmp/pw-chat-modal.png' });

    // ── 6. Verify all Phase 7 footer buttons present ──────────────────────────
    const footer = page.locator('.apm-footer');
    await expect(footer.locator('.apm-dl-btn')).toBeVisible({ timeout: 5000 });
    await expect(footer.locator('.apm-share-btn')).toBeVisible({ timeout: 5000 });
    await expect(footer.locator('.apm-embed-btn')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: '/tmp/pw-chat-modal-footer.png' });
    console.log('[chat test] All Phase 7 buttons visible ✓');
  });

  test('Chat: artifact → Share button → dialog shows URL → public page works', async ({ page }) => {
    const chatId = await createArtifactChat(page);
    await navigateToChat(page, chatId);

    await sendMessage(
      page,
      'Use emit_artifact to create a markdown artifact named "share-demo.md" with content "# Share Demo\n\nPublic share URL test."',
    );
    await waitForArtifactCard(page);

    // Open preview modal
    await page.locator('.artifact-card').first().click();
    await expect(page.locator('#artifact-preview-overlay')).toBeVisible({ timeout: 8000 });

    // Click Share
    const shareBtn = page.locator('.apm-share-btn');
    await expect(shareBtn).toBeVisible({ timeout: 5000 });
    await shareBtn.click();
    await page.screenshot({ path: '/tmp/pw-chat-share-btn-clicked.png' });

    // Share dialog appears
    await expect(page.locator('.share-dialog-overlay')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.share-dialog-title')).toContainText('Share');
    const shareUrl = await page.locator('.share-dialog-url').inputValue();
    expect(shareUrl).toContain('/share/artifacts/');
    console.log('[chat test] share URL:', shareUrl);
    await page.screenshot({ path: '/tmp/pw-chat-share-dialog.png' });

    // Open share URL in a new tab as anonymous user
    const sharePath = shareUrl.startsWith('http') ? new URL(shareUrl).pathname : shareUrl;
    const anonCtx = await page.context().browser()!.newContext();
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(sharePath);
    await expect(anonPage.locator('#share-footer')).toBeVisible({ timeout: 10000 });
    await expect(anonPage.locator('#share-footer')).toContainText('Shared via geneWeave');
    await anonPage.screenshot({ path: '/tmp/pw-chat-anon-share.png' });
    console.log('[chat test] public share page loaded ✓');
    await anonCtx.close();
  });

  test('Chat: artifact → Embed button → dialog shows iframe code', async ({ page }) => {
    const chatId = await createArtifactChat(page);
    await navigateToChat(page, chatId);

    await sendMessage(
      page,
      'Use emit_artifact to create a markdown artifact named "embed-demo.md" with content "# Embed Demo\n\niframe embed test."',
    );
    await waitForArtifactCard(page);

    await page.locator('.artifact-card').first().click();
    await expect(page.locator('#artifact-preview-overlay')).toBeVisible({ timeout: 8000 });

    const embedBtn = page.locator('.apm-embed-btn');
    await expect(embedBtn).toBeVisible({ timeout: 5000 });
    await embedBtn.click();

    await expect(page.locator('.share-dialog-overlay')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.share-dialog-title')).toContainText('Embed');
    const embedCode = await page.locator('.share-dialog-embed').inputValue();
    expect(embedCode).toContain('<iframe');
    expect(embedCode).toContain('/share/artifacts/');
    console.log('[chat test] embed code:', embedCode.slice(0, 80) + '…');
    await page.screenshot({ path: '/tmp/pw-chat-embed-dialog.png' });
  });

  test('Chat: artifact → Download link uses /download endpoint', async ({ page }) => {
    const chatId = await createArtifactChat(page);
    await navigateToChat(page, chatId);

    await sendMessage(
      page,
      'Use emit_artifact to create a markdown artifact named "download-demo.md" with content "# Download Demo\n\nTyped attachment test."',
    );
    await waitForArtifactCard(page);

    await page.locator('.artifact-card').first().click();
    await expect(page.locator('#artifact-preview-overlay')).toBeVisible({ timeout: 8000 });

    const dlBtn = page.locator('.apm-dl-btn');
    await expect(dlBtn).toBeVisible({ timeout: 5000 });
    const href = await dlBtn.getAttribute('href');
    expect(href).toMatch(/\/api\/artifacts\/.+\/download/);

    // Verify the endpoint returns a proper attachment
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-type']).toContain('text/markdown');
    console.log('[chat test] download href:', href);
    await page.screenshot({ path: '/tmp/pw-chat-download-verified.png' });
  });

  test('Chat: JSON artifact → typed download returns application/json', async ({ page }) => {
    const chatId = await createArtifactChat(page);
    await navigateToChat(page, chatId);

    await sendMessage(
      page,
      'Use emit_artifact to create a JSON artifact named "data.json" with type "json" and content {"title":"Phase7 Test","tags":["share","embed","download"],"version":7}',
    );
    await waitForArtifactCard(page);

    await page.locator('.artifact-card').first().click();
    await expect(page.locator('#artifact-preview-overlay')).toBeVisible({ timeout: 8000 });

    const dlBtn = page.locator('.apm-dl-btn');
    const href = await dlBtn.getAttribute('href');
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    console.log('[chat test] JSON download MIME:', res.headers()['content-type']);
    await page.screenshot({ path: '/tmp/pw-chat-json-download.png' });
  });
});
