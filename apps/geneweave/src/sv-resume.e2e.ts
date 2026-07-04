/**
 * Scientific Validation — Resume Flow Playwright Tests
 *
 * Tests the "Back → Resume" flow: after navigating back from the live view,
 * the submit form should show recent hypotheses with a Resume button.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const SV_EMAIL = 'pw-sv-resume@weaveintel.dev';

async function registerAndEnter(page: Page) {
  await page.goto('/');
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  let login = await page.request.post('/api/auth/login', {
    data: { email: SV_EMAIL, password: PASSWORD },
  });
  if (login.status() !== 200) {
    await page.request.post('/api/auth/register', {
      data: { name: 'SV Resume User', email: SV_EMAIL, password: PASSWORD },
    });
    login = await page.request.post('/api/auth/login', {
      data: { email: SV_EMAIL, password: PASSWORD },
    });
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 8000 });
}

async function openSVView(page: Page) {
  const svBtn = page.getByRole('button', { name: /Validation/i }).first();
  await expect(svBtn).toBeVisible({ timeout: 5000 });
  await svBtn.click();
  await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 5000 });
}

test.describe('SV Back → Resume Flow', () => {

  test('A. Submit form shows Recent Validations when hypotheses exist', async ({ page }) => {
    await registerAndEnter(page);

    // Mock the list endpoint BEFORE opening SV view so loadRecent() sees the mock
    await page.route('/api/sv/hypotheses', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hypotheses: [
              { id: 'resume-hyp-001', title: 'Aspirin reduces MI risk', status: 'running', createdAt: new Date().toISOString() },
            ],
          }),
        });
        return;
      }
      await route.continue();
    });

    await openSVView(page);

    // Recent Validations panel should appear (loadRecent fires 50ms after render)
    await expect(page.getByText('Recent Validations')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Aspirin reduces MI risk')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button', { hasText: 'Resume' })).toBeVisible({ timeout: 5000 });
  });

  test('B. Clicking Resume navigates to live view for that hypothesis', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    const HYP_ID = 'resume-hyp-002';

    // Mock all endpoints BEFORE opening SV view
    await page.route('/api/sv/hypotheses', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hypotheses: [
              { id: HYP_ID, title: 'Vitamin D reduces COVID-19 severity', status: 'running', createdAt: new Date().toISOString() },
            ],
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}/events`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}/dialogue`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: HYP_ID, title: 'Vitamin D reduces COVID-19 severity', status: 'running', createdAt: new Date().toISOString() },
          verdict: null,
        }),
      });
    });

    await openSVView(page);

    // Recent Validations section with Resume button should appear
    await expect(page.getByText('Recent Validations')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button', { hasText: 'Resume' })).toBeVisible({ timeout: 5000 });

    // Click Resume
    await page.locator('button', { hasText: 'Resume' }).click();

    // Should navigate to live deliberation view
    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });
  });

  test('C. Full flow: submit → live → Back → submit shows Resume → click Resume → live', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    const HYP_ID = 'full-flow-hyp-003';

    // Mock POST to create hypothesis
    await page.route('/api/sv/hypotheses', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: HYP_ID, status: 'queued', traceId: 'tr-003', contractId: 'co-003' }),
        });
        return;
      }
      // GET list — return the same hypothesis as running
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypotheses: [
            { id: HYP_ID, title: 'Full flow hypothesis', status: 'running', createdAt: new Date().toISOString() },
          ],
        }),
      });
    });

    // Mock SSE + status for live view
    await page.route(`/api/sv/hypotheses/${HYP_ID}/events`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}/dialogue`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: HYP_ID, title: 'Full flow hypothesis', status: 'running', createdAt: new Date().toISOString() },
          verdict: null,
        }),
      });
    });

    // Step 1: Fill form and submit
    await page.locator('input[placeholder*="title" i], input[placeholder*="Title" i]').first().fill('Full flow hypothesis');
    await page.locator('textarea').first().fill('This is a full end-to-end flow test for the resume capability.');
    await page.locator('button', { hasText: /Submit|Validate|Analyse/i }).click();

    // Step 2: Verify live view
    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });

    // Step 3: Click ← Back
    await page.locator('button', { hasText: '← Back' }).click();

    // Step 4: Verify back on submit form
    await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 5000 });

    // Step 5: Recent Validations section with Resume button
    await expect(page.getByText('Recent Validations')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button', { hasText: 'Resume' })).toBeVisible({ timeout: 5000 });

    // Step 6: Click Resume — should go back to live view
    await page.locator('button', { hasText: 'Resume' }).click();
    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });
  });

  test('D. Back button clears hypothesisId so localStorage does not restore to live', async ({ page }) => {
    await registerAndEnter(page);
    await openSVView(page);

    const HYP_ID = 'back-clear-hyp-004';

    await page.route('/api/sv/hypotheses', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: HYP_ID, status: 'queued', traceId: 'tr-004', contractId: 'co-004' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hypotheses: [] }),
      });
    });

    await page.route(`/api/sv/hypotheses/${HYP_ID}/events`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}/dialogue`, async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.route(`/api/sv/hypotheses/${HYP_ID}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hypothesis: { id: HYP_ID, title: 'Back clear test', status: 'running', createdAt: new Date().toISOString() },
          verdict: null,
        }),
      });
    });

    // Submit → live
    await page.locator('input[placeholder*="title" i], input[placeholder*="Title" i]').first().fill('Back clear test');
    await page.locator('textarea').first().fill('Checking that Back clears svHypothesisId from state.');
    await page.locator('button', { hasText: /Submit|Validate|Analyse/i }).click();
    await expect(page.locator('h2', { hasText: /Deliberation|Live|Running/i })).toBeVisible({ timeout: 8000 });

    // Click Back
    await page.locator('button', { hasText: '← Back' }).click();
    await expect(page.locator('h2', { hasText: 'Validate a Hypothesis' })).toBeVisible({ timeout: 5000 });

    // Verify state: svView = 'submit', svHypothesisId = null
    const { svView, svHypothesisId } = await page.evaluate(() => ({
      svView: (window as any).state?.svView,
      svHypothesisId: (window as any).state?.svHypothesisId,
    }));

    expect(svView).toBe('submit');
    expect(svHypothesisId).toBeNull();
  });
});
