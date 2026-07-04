/**
 * Scientific Validation — Playwright E2E Tests
 *
 * Covers the full SV UI flow:
 *  1. SV nav entry is visible after login
 *  2. Clicking SV nav renders the submit form
 *  3. Submit form validates required fields
 *  4. Successful submission transitions to the live deliberation view
 *  5. Live view shows SSE event panels
 *  6. Cancel button stops the run and returns to submit
 *  7. Verdict view renders after a verdict event
 *  8. Bundle download link is present on the verdict view
 *
 * Run: npx playwright test sv-ui.e2e.ts --config playwright.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

// ── Constants ─────────────────────────────────────────────────────────────────

const PASSWORD = 'Str0ng!Pass99';
const SV_EMAIL = 'pw-sv-e2e@weaveintel.dev';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? SV_EMAIL;
  await page.goto('/');

  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });
  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'SV E2E User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());
    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 8000 });
}

async function openSVView(page: Page) {
  const svBtn = page.getByRole('button', { name: /Validation/i }).first();
  await expect(svBtn).toBeVisible({ timeout: 5000 });
  await svBtn.click();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Scientific Validation UI', () => {
  test('1. SV nav button is visible after login', async ({ page }) => {
    await registerAndEnter(page);
    const svBtn = page.getByRole('button', { name: /Validation/i }).first();
    await expect(svBtn).toBeVisible({ timeout: 5000 });
  });

  test('2. Clicking SV nav renders the submit form', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[placeholder*="title" i]').or(page.locator('input[placeholder*="Title" i]'))).toBeVisible();
    await expect(page.locator('textarea[placeholder*="statement" i]').or(page.locator('textarea[placeholder*="State" i]'))).toBeVisible();
  });

  test('3. Submit form validates required fields', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    // Try to submit without filling in the form
    const submitBtn = page.locator('button', { hasText: /Submit|Validate|Analyse/i });
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    // Should not navigate away — still on submit form
    await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 2000 });
  });

  test('4. Valid submission transitions to live deliberation view', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    // Intercept the POST to mock a success
    await page.route('/api/sv/hypotheses', async route => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'test-hypothesis-001',
          status: 'queued',
          traceId: 'trace-001',
          contractId: 'contract-001',
        }),
      });
    });

    // Fill in the form
    await page.locator('input[placeholder*="title" i], input[placeholder*="Title" i]').first().fill('Aspirin reduces MI risk');
    await page.locator('textarea').first().fill(
      'Low-dose aspirin reduces the rate of recurrent myocardial infarction by approximately 25% in patients with established cardiovascular disease.'
    );

    const submitBtn = page.locator('button', { hasText: /Submit|Validate|Analyse/i });
    await submitBtn.click();

    // Should transition to the live view
    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });
  });

  test('5. Live view has evidence and dialogue panels', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    await page.route('/api/sv/hypotheses', async route => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-hypothesis-002', status: 'queued', traceId: 'trace-002', contractId: 'contract-002' }),
      });
    });

    // Mock the SSE endpoints to emit nothing (just return 200 with empty body)
    await page.route('/api/sv/hypotheses/test-hypothesis-002/events', async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route('/api/sv/hypotheses/test-hypothesis-002/dialogue', async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route('/api/sv/hypotheses/test-hypothesis-002', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: 'test-hypothesis-002', title: 'Test', status: 'running', createdAt: new Date().toISOString() },
          verdict: null,
        }),
      });
    });

    await page.locator('input[placeholder*="title" i], input[placeholder*="Title" i]').first().fill('Evidence Panel Test');
    await page.locator('textarea').first().fill('A hypothesis to test that the evidence panel renders.');
    await page.locator('button', { hasText: /Submit|Validate|Analyse/i }).click();

    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });
    // Panels should be present
    await expect(page.locator('div', { hasText: /Evidence|Agent/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test('6. Cancel button is present and calls cancel API', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    await page.route('/api/sv/hypotheses', async route => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-hypothesis-003', status: 'queued', traceId: 'trace-003', contractId: 'contract-003' }),
      });
    });

    let cancelCalled = false;
    await page.route('/api/sv/hypotheses/test-hypothesis-003/cancel', async route => {
      cancelCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-hypothesis-003', status: 'abandoned' }),
      });
    });
    await page.route('/api/sv/hypotheses/test-hypothesis-003/events', async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route('/api/sv/hypotheses/test-hypothesis-003/dialogue', async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route('/api/sv/hypotheses/test-hypothesis-003', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: 'test-hypothesis-003', title: 'Cancel test', status: 'running', createdAt: new Date().toISOString() },
          verdict: null,
        }),
      });
    });

    await page.locator('input[placeholder*="title" i], input[placeholder*="Title" i]').first().fill('Cancel Test Hypothesis');
    await page.locator('textarea').first().fill('This hypothesis exists to test the cancel button.');
    await page.locator('button', { hasText: /Submit|Validate|Analyse/i }).click();

    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });

    const cancelBtn = page.locator('button', { hasText: /Cancel/i });
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    await cancelBtn.click();

    expect(cancelCalled).toBe(true);
    // Should return to submit form
    await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 5000 });
  });

  test('7. Verdict view renders with verdict label and confidence', async ({ page }) => {
    await registerAndEnter(page);

    // Navigate directly to verdict view by manipulating state via the API
    // We mock all necessary API calls
    const hypothesisId = 'test-verdict-hypothesis';
    const verdictId = 'test-verdict-001';

    await page.route(`/api/sv/hypotheses/${hypothesisId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: hypothesisId, title: 'Verdict Test', status: 'verdict', createdAt: new Date().toISOString() },
          verdict: {
            id: verdictId,
            verdict: 'supported',
            confidenceLo: 0.75,
            confidenceHi: 0.92,
            limitations: 'Single meta-analysis; publication bias possible.',
            emittedBy: 'supervisor',
          },
        }),
      });
    });

    await page.route(`/api/sv/verdicts/${verdictId}/bundle`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: '1.0.0',
          hypothesis: { title: 'Verdict Test', statement: 'Test statement' },
          verdict: {
            id: verdictId, verdict: 'supported', confidenceLo: 0.75, confidenceHi: 0.92,
            limitations: 'Single meta-analysis.', emittedBy: 'supervisor',
          },
          subClaims: [
            { id: 'sc-001', statement: 'Aspirin inhibits thromboxane A2 production', claimType: 'mechanism', testabilityScore: 0.9 },
          ],
          evidenceEvents: [
            { evidenceId: 'ev-001', kind: 'literature', summary: 'ATT Collaboration 2002', agentId: 'literature' },
          ],
        }),
      });
    });

    await openSVView(page);

    // Use evaluate to set svView and svHypothesisId directly on state
    await page.evaluate((id) => {
      (window as any).state = (window as any).state ?? {};
      (window as any).state.svView = 'verdict';
      (window as any).state.svHypothesisId = id;
    }, hypothesisId);

    // Trigger a re-render by navigating again
    const svBtn = page.getByRole('button', { name: /Validation/i }).first();
    await svBtn.click();

    // Check verdict view content — label should be present
    await expect(page.locator('div', { hasText: /Supported|Refuted|Inconclusive/i }).first()).toBeVisible({ timeout: 8000 });
  });

  test('8. Bundle download link is present in verdict view', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    // Set up state to show verdict view
    await page.route('/api/sv/hypotheses/test-bundle-hyp', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: 'test-bundle-hyp', title: 'Bundle Test', status: 'verdict', createdAt: new Date().toISOString() },
          verdict: { id: 'bundle-verdict-001', verdict: 'supported', confidenceLo: 0.6, confidenceHi: 0.85 },
        }),
      });
    });
    await page.route('/api/sv/verdicts/bundle-verdict-001/bundle', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: '1.0.0',
          hypothesis: { title: 'Bundle Test', statement: 'Bundle test statement' },
          verdict: { id: 'bundle-verdict-001', verdict: 'supported', confidenceLo: 0.6, confidenceHi: 0.85 },
          subClaims: [],
          evidenceEvents: [],
        }),
      });
    });

    await page.evaluate(() => {
      (window as any).state = (window as any).state ?? {};
      (window as any).state.svView = 'verdict';
      (window as any).state.svHypothesisId = 'test-bundle-hyp';
    });

    const svBtn = page.getByRole('button', { name: /Validation/i }).first();
    await svBtn.click();

    await expect(page.locator('a', { hasText: /Download.*Bundle/i })).toBeVisible({ timeout: 8000 });
  });
});
