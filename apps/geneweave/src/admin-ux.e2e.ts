import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';

const ADMIN_TAB_GROUPS: Record<string, string> = {
  prompts: 'Prompt Studio',
  guardrails: 'Governance',
  routing: 'Orchestration',
  'tool-simulation': 'Orchestration',
  'tool-approval-requests': 'Orchestration',
};

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? ADMIN_EMAIL;
  await page.goto('/');

  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });

  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'Admin UX User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());

    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 5000 });
}

async function goAdmin(page: Page) {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
}

async function openAdminTab(page: Page, tabKey: keyof typeof ADMIN_TAB_GROUPS) {
  const groupLabel = ADMIN_TAB_GROUPS[tabKey];
  const adminMenu = page.locator('.admin-nav-sub');
  if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-parent').click();
    await expect(adminMenu).toBeVisible({ timeout: 5000 });
  }

  const tabButton = page.locator(`[data-admin-tab="${tabKey}"]`).first();
  if (!(await tabButton.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-group-btn', { hasText: groupLabel }).click();
  }

  await expect(tabButton).toBeVisible({ timeout: 5000 });
  await tabButton.click();
}

test.describe('Admin UX Regression', () => {
  test('tab switch closes editor state', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'guardrails');
    await m.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ }).click();

    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
    await expect(m.locator('.admin-list-panel')).toHaveCount(0);
    await expect(m.locator('.admin-form-title', { hasText: 'New Guardrail' })).toBeVisible({ timeout: 3000 });

    await openAdminTab(page, 'routing');

    await expect(m.locator('.admin-breadcrumbs')).toHaveCount(0);
    await expect(m.locator('.admin-form-title', { hasText: 'New Guardrail' })).toHaveCount(0);
  });

  test('breadcrumb returns from form to list', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'guardrails');

    const editBtn = m.locator('.admin-list-panel button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
    } else {
      await m.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ }).click();
    }

    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
    await expect(m.locator('.admin-list-panel')).toHaveCount(0);
    await m.locator('[data-testid="admin-breadcrumb-back"]').click();
    await expect(m.locator('.admin-breadcrumbs')).toHaveCount(0);
    await expect(m.locator('.admin-list-panel')).toBeVisible({ timeout: 3000 });
  });

  test('prompts opens list first then wizard on edit/new', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'prompts');

    await expect(m.locator('.admin-list-panel')).toBeVisible({ timeout: 5000 });
    await expect(m.locator('.prompt-wizard')).toHaveCount(0);

    const editBtn = m.locator('.admin-list-panel button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editBtn.click();
    } else {
      await m.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ }).click();
    }

    await expect(m.locator('.prompt-wizard')).toBeVisible({ timeout: 5000 });
    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
  });

  test('insert marker inserts at cursor without overwriting template text', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'prompts');
    await m.locator('.admin-list-header button.nav-btn').filter({ hasText: /^\+ New$/ }).click();
    await expect(m.locator('.prompt-wizard')).toBeVisible({ timeout: 5000 });

    const options = m.locator('[data-testid="prompt-fragment-select"] option');
    const optionCount = await options.count();
    test.skip(optionCount < 2, 'No existing prompt fragments available to validate marker insertion.');
    const fragmentKey = await options.nth(1).getAttribute('value');
    expect(fragmentKey).toBeTruthy();

    await m.locator('[data-testid="prompt-fragment-select"]').selectOption(fragmentKey!);
    const editor = m.locator('[data-testid="prompt-template-editor"]');
    await editor.fill('Alpha Beta Gamma');

    await editor.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(6, 6);
    });

    await m.locator('[data-testid="insert-fragment-marker"]').click();

    const updated = await editor.inputValue();
    expect(updated).toContain(`{{>${fragmentKey!}}}`);
    expect(updated.startsWith('Alpha ')).toBeTruthy();
    expect(updated.endsWith('Beta Gamma')).toBeTruthy();
  });

  test('tool-simulation tab is accessible and renders custom UI', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'tool-simulation');

    // Custom view should be rendered — no standard admin-list-panel
    await expect(m.locator('.admin-list-panel')).toHaveCount(0);

    // Simulation container heading is visible
    await expect(m.locator('.sim-container')).toBeVisible({ timeout: 5000 });

    // Tool select dropdown is rendered once tools are loaded
    await expect(m.locator('select')).toBeVisible({ timeout: 5000 });

    // Dry run and run buttons are present
    await expect(m.locator('button', { hasText: 'Dry Run' })).toBeVisible({ timeout: 5000 });
    await expect(m.locator('button', { hasText: 'Run Simulation' })).toBeVisible({ timeout: 5000 });
  });

  test('tool-simulation dry run shows policy trace', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await openAdminTab(page, 'tool-simulation');

    // Wait for tool select to be populated
    const toolSelect = m.locator('select').first();
    await expect(toolSelect).toBeVisible({ timeout: 5000 });
    await toolSelect.waitFor({ state: 'attached' });

    // Ensure a tool is selected (calculator should be in list)
    const options = toolSelect.locator('option');
    const optionCount = await options.count();
    test.skip(optionCount < 2, 'No tools loaded in simulation tab.');

    await toolSelect.selectOption({ index: 1 });

    // Click Dry Run
    await m.locator('button', { hasText: 'Dry Run' }).click();

    // Policy trace should appear
    await expect(m.locator('.sim-policy-trace')).toBeVisible({ timeout: 8000 });
    const traceEntries = m.locator('.sim-trace-entry');
    await expect(traceEntries.first()).toBeVisible({ timeout: 3000 });
  });

  test('tool-approval-requests tab is accessible and renders custom view', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    await openAdminTab(page, 'tool-approval-requests');

    // Custom view container should render with the approval-specific heading
    const container = page.locator('.approval-container').first();
    await expect(container).toBeVisible({ timeout: 8000 });
    await expect(container.locator('h3', { hasText: 'Tool Approval Requests' })).toBeVisible({ timeout: 3000 });

    // Status filter buttons should be present
    await expect(container.locator('button', { hasText: 'Pending' })).toBeVisible({ timeout: 3000 });
    await expect(container.locator('button', { hasText: 'All' })).toBeVisible({ timeout: 3000 });
    await expect(container.locator('button', { hasText: 'Approved' })).toBeVisible({ timeout: 3000 });
    await expect(container.locator('button', { hasText: 'Denied' })).toBeVisible({ timeout: 3000 });
  });

  test('tool-approval-requests tab shows empty state or request cards', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    await openAdminTab(page, 'tool-approval-requests');

    await expect(page.locator('.approval-container').first()).toBeVisible({ timeout: 8000 });

    // Wait for async load to settle — either an empty state or cards must appear in any container
    const emptyOrCards = page.locator('.approval-container .approval-empty, .approval-container .approval-card');
    await expect(emptyOrCards.first()).toBeVisible({ timeout: 15000 });
  });
});
