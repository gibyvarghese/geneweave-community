import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? ADMIN_EMAIL;
  await page.goto('/');

  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });
  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'Playwright Grounding User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());
    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
}

test.describe('Grounding Chat UI', () => {
  test('renders post-check grounding and guardrail warnings in the assistant response corner', async ({ page }) => {
    await registerAndEnter(page);

    await page.route('**/api/chats/*/messages', async (route) => {
      const events = [
        { type: 'text', text: 'BANANA' },
        {
          type: 'cognitive',
          confidence: 0.31,
          decision: 'warn',
          riskLevel: 'low',
          checks: [
            {
              guardrailId: 'guard-cog-post-grounding',
              decision: 'warn',
              explanation: 'Low grounding overlap with user query. Consider adding references, assumptions, or explicit uncertainty.',
              confidence: 0.1,
            },
            {
              guardrailId: 'guard-cog-post-confidence',
              decision: 'warn',
              explanation: 'Post-check confidence 31% (risk=low).',
              confidence: 0.31,
            },
          ],
        },
        { type: 'guardrail', decision: 'warn', reason: 'Low grounding overlap detected.' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, cost: 0, latencyMs: 12 },
      ];
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body,
      });
    });

    await page.locator('textarea').fill('What is the capital of France?');
    await page.locator('button.send-btn').click({ force: true });

    const lastAssistant = page.locator('.msg.assistant').last();
    await expect(lastAssistant.locator('.bubble')).toContainText('BANANA', { timeout: 15_000 });

    const warnCount = await lastAssistant.locator('.resp-corner .resp-ind.warn').count();
    expect(warnCount).toBeGreaterThanOrEqual(2);
  });
});