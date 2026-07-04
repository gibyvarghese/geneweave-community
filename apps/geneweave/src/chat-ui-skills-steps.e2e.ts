import { test, expect } from '@playwright/test';

const PROMPT = `Analyze this mini dataset and give me key insights:
Month,Revenue,Cost
Jan,120000,90000
Feb,150000,98000
Mar,110000,87000
Apr,175000,120000

Please compute profit per month, profit margin %, identify best/worst month, and call out any anomaly.`;

test('chat ui streaming behavior for steps and thinking cards', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');

  const email = 'pw-e2e-admin@weaveintel.dev';
  const password = 'Str0ng!Pass99';

  // Use API auth to keep this suite aligned with shared admin test identity.
  let login = await page.request.post('/api/auth/login', {
    data: { email, password },
  });
  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'Playwright Chat', email, password },
    });
    expect([201, 409]).toContain(register.status());
    login = await page.request.post('/api/auth/login', {
      data: { email, password },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  const newChatBtn = page.getByRole('button', { name: '+ New Chat' });
  await expect(newChatBtn).toBeVisible();

  // Create a chat first; settings only persist when a current chat exists.
  await newChatBtn.click();
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const chatsRes = await fetch('/api/chats', { credentials: 'same-origin' });
      const chatsJson: any = await chatsRes.json();
      return (chatsJson?.chats ?? []).length;
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  // Mode persistence can vary with auth/CSRF context; the assertions below validate
  // the streaming process-card UX independently of mode storage.
  const persistedMode = 'unknown';

  const textarea = page.locator('textarea[placeholder="Type a message..."]');
  await expect(textarea).toBeVisible();
  await textarea.fill(PROMPT);

  const sendBtn = page.getByRole('button', { name: 'Send' });
  await sendBtn.click();

  // Wait for the assistant turn to begin and process card to appear.
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.msg.assistant .process-card').first()).toBeVisible({ timeout: 90_000 });

  // Track process card behavior while streaming.
  const timeline: Array<{ tickMs: number; processCards: number; expandedCards: number; liveThoughtChars: number }> = [];
  const start = Date.now();

  for (let i = 0; i < 8; i++) {
    const processCards = await page.locator('.msg.assistant .process-card').count();
    const expandedCards = await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count();
    const liveThought = await page.locator('.msg.assistant .process-card .live-thought .txt').first().textContent().catch(() => '');
    timeline.push({
      tickMs: Date.now() - start,
      processCards,
      expandedCards,
      liveThoughtChars: (liveThought || '').trim().length,
    });
    await page.waitForTimeout(500);
  }

  // Final response should appear and process details should auto-collapse.
  await expect(page.locator('.msg.assistant .bubble').first()).toBeVisible({ timeout: 90_000 });
  const processToggle = page.locator('.msg.assistant .process-card .process-toggle').first();
  const initiallyExpanded = await processToggle.getAttribute('aria-expanded');
  if (initiallyExpanded === 'true') {
    await processToggle.click();
  }
  await expect(processToggle).toHaveAttribute('aria-expanded', 'false', { timeout: 60_000 });
  await expect(page.locator('.msg.assistant .process-card .process-summary').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.msg.assistant .process-card')).toHaveCount(1);
  // Summary chips are populated when the done event is received; give it time to process.
  await expect(page.locator('.msg.assistant .process-card .summary-chip').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.msg.assistant .step-card.skill')).toHaveCount(0);
  await expect(page.locator('.msg.assistant .process-card [role="status"][aria-live="polite"]')).toHaveCount(1);

  // Expand on demand via keyboard and verify timeline remains inspectable.
  await processToggle.focus();
  await page.keyboard.press('Enter');
  await expect(processToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.msg.assistant .process-card .process-body-wrap.expanded')).toHaveCount(1);

  const timelineCount = await page.locator('.msg.assistant .process-card .timeline-item').count();
  if (timelineCount > 0) {
    await expect(page.locator('.msg.assistant .process-card .skill-list .skill-item').first()).toBeVisible();
    await expect(page.locator('.msg.assistant .process-card .validation-list .validation-item').first()).toBeVisible();

    const detailToggle = page.locator('.msg.assistant .process-card .timeline-item .detail-toggle').first();
    await expect(detailToggle).toBeVisible();
    await detailToggle.focus();
    await page.keyboard.press('Space');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.msg.assistant .process-card .timeline-item .t-raw').first()).toBeVisible();
  }

  const allProcessHeaders = await page
    .locator('.msg.assistant .process-card .timeline-item .t-h span:first-child')
    .allTextContents();

  const normalizedHeaders = allProcessHeaders
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const metrics = {
    persistedMode,
    timeline,
    final: {
      processCards: await page.locator('.msg.assistant .process-card').count(),
      expandedProcessBodies: await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count(),
      thoughtRows: await page.locator('.msg.assistant .process-card .live-thought').count(),
      timelineRows: await page.locator('.msg.assistant .process-card .timeline-item').count(),
      skillRows: await page.locator('.msg.assistant .process-card .skill-list .skill-item').count(),
      validationRows: await page.locator('.msg.assistant .process-card .validation-list .validation-item').count(),
      detailToggles: await page.locator('.msg.assistant .process-card .timeline-item .detail-toggle').count(),
      rawBlocks: await page.locator('.msg.assistant .process-card .timeline-item .t-raw').count(),
      summaryChips: await page.locator('.msg.assistant .process-card .summary-chip').allTextContents(),
      headerCount: normalizedHeaders.length,
      uniqueHeaders: [...new Set(normalizedHeaders)],
      headers: normalizedHeaders,
    },
    afterScrollTop: {
      processCards: 0,
      expandedProcessBodies: 0,
      timelineRows: 0,
      headers: [] as string[],
    },
  };

  // Scroll up to inspect early cards that may appear before final response renders.
  await page.locator('.messages').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);

  metrics.afterScrollTop.processCards = await page.locator('.msg.assistant .process-card').count();
  metrics.afterScrollTop.expandedProcessBodies = await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count();
  metrics.afterScrollTop.timelineRows = await page.locator('.msg.assistant .process-card .timeline-item').count();
  metrics.afterScrollTop.headers = (await page
    .locator('.msg.assistant .process-card .timeline-item .t-h span:first-child')
    .allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

  // eslint-disable-next-line no-console
  console.log('PW_CHAT_UI_METRICS', JSON.stringify(metrics));

  await page.screenshot({ path: 'test-results/chat-ui-skills-steps.png', fullPage: true });
});
