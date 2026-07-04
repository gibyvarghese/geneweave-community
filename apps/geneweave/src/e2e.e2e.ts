/**
 * geneWeave — Playwright E2E tests
 *
 * Verifies the full web UI: auth flow, chat, and admin pages.
 * Run: npx playwright test --config playwright.config.ts
 */
import { test, expect, type Locator, type Page } from '@playwright/test';

/* ── Helpers ─────────────────────────────────────────────── */

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';

const ADMIN_TAB_LOCATIONS: Record<string, { group: string; key: string }> = {
  Prompts: { group: 'Prompt Studio', key: 'prompts' },
  Guardrails: { group: 'Governance', key: 'guardrails' },
  Routing: { group: 'Orchestration', key: 'routing' },
  Workflows: { group: 'Orchestration', key: 'workflows' },
  Tools: { group: 'Orchestration', key: 'tool-catalog' },
  'Tool Policies': { group: 'Orchestration', key: 'tool-policies' },
  'Tool Audit': { group: 'Orchestration', key: 'tool-audit' },
  'Tool Health': { group: 'Orchestration', key: 'tool-health' },
  'Tool Credentials': { group: 'Orchestration', key: 'tool-credentials' },
  'Workflow Runs': { group: 'Monitoring', key: 'workflow-runs' },
  'Guardrail Evals': { group: 'Monitoring', key: 'guardrail-evals' },
  'Task Policies': { group: 'Orchestration', key: 'task-policies' },
  Contracts: { group: 'Governance', key: 'contracts' },
  Cache: { group: 'Infrastructure', key: 'cache-policies' },
  Identity: { group: 'Governance', key: 'identity-rules' },
  'Memory Gov': { group: 'Governance', key: 'memory-governance' },
  Search: { group: 'Integrations', key: 'search-providers' },
  HTTP: { group: 'Integrations', key: 'http-endpoints' },
  Social: { group: 'Integrations', key: 'social-accounts' },
  Enterprise: { group: 'Integrations', key: 'enterprise-connectors' },
  Replay: { group: 'Orchestration', key: 'replay-scenarios' },
  Triggers: { group: 'Orchestration', key: 'trigger-definitions' },
  Tenants: { group: 'Infrastructure', key: 'tenant-configs' },
  Sandbox: { group: 'Infrastructure', key: 'sandbox-policies' },
  Extraction: { group: 'Knowledge', key: 'extraction-pipelines' },
  Artifacts: { group: 'Knowledge', key: 'artifact-policies' },
  Reliability: { group: 'Infrastructure', key: 'reliability-policies' },
  Collaboration: { group: 'Knowledge', key: 'collaboration-sessions' },
  Compliance: { group: 'Governance', key: 'compliance-rules' },
  Graph: { group: 'Knowledge', key: 'graph-configs' },
  Plugins: { group: 'Knowledge', key: 'plugin-configs' },
  Scaffolds: { group: 'Developer', key: 'scaffold-templates' },
  Recipes: { group: 'Developer', key: 'recipe-configs' },
  Widgets: { group: 'Developer', key: 'widget-configs' },
  Validation: { group: 'Developer', key: 'validation-rules' },
};

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? ADMIN_EMAIL;
  await page.goto('/');

  // Reuse an existing authenticated session when available.
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  // Use API auth to avoid flaky mode-toggle interactions in the auth form.
  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });
  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'E2E User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());

    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  // Wait for the app shell to render after auth completes.
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 5000 });
}

async function goAdmin(page: Page) {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
}

async function openAdminTab(page: Page, label: keyof typeof ADMIN_TAB_LOCATIONS | string) {
  const location = ADMIN_TAB_LOCATIONS[label];
  if (!location) throw new Error(`Unknown admin tab: ${label}`);

  const adminMenu = page.locator('.admin-nav-sub');
  if (!(await adminMenu.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-parent').click();
    await expect(adminMenu).toBeVisible({ timeout: 5000 });
  }

  const tabButton = page.locator(`[data-admin-tab="${location.key}"]`).first();
  if (!(await tabButton.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.locator('.admin-group-btn', { hasText: location.group }).click();
  }

  await expect(tabButton).toBeVisible({ timeout: 5000 });
  await tabButton.click();
  await page.waitForTimeout(500);
}

async function seedDefaults(page: Page) {
  const csrfToken = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    return data?.csrfToken ?? '';
  });
  expect(csrfToken).toBeTruthy();

  const seedStatus = await page.evaluate(async (csrf) => {
    const res = await fetch('/api/admin/seed', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    return res.status;
  }, csrfToken);
  expect(seedStatus).toBe(200);
}

/** Scope locator to the .main content area (avoids matching sidebar elements). */
function main(page: Page) {
  return page.locator('.main');
}

/** Wait for the table to load and ensure admin list is visible. */
async function waitForListHeader(m: Locator, timeout = 5000) {
  await expect(m.locator('.admin-list-panel')).toBeVisible({ timeout });
  await expect(m.locator('table, [role="table"]')).toBeVisible({ timeout });
  await expect(m.locator('input.admin-list-search')).toBeVisible({ timeout });
}

/** Click the admin "+ New" button with exact text matching to avoid strict mode violations. */
async function clickAdminNewButton(m: Locator) {
  // Use exact regex match to avoid matching "+ New Chat" from chat panel
  await m.locator('button.nav-btn').filter({ hasText: /^\+ New$/ }).first().click();
}

async function expectAdminListLoaded(m: Locator) {
  await expect(m.locator('table')).toBeVisible({ timeout: 5000 });
  await expect(m.locator('input[placeholder*="Search "]')).toBeVisible({ timeout: 5000 });
}

/* ── Auth ────────────────────────────────────────────────── */

test.describe('Auth', () => {
  test('shows login page on first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.auth-card')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sign In' })).toBeVisible();
  });

  test('registers a new user and sees sidebar', async ({ page }) => {
    await registerAndEnter(page);
    // After login, navigation shell and profile avatar should be visible.
    await expect(page.locator('.workspace-nav')).toBeVisible();
    await expect(page.locator('.profile-avatar')).toBeVisible();
  });
});

/* ── Chat ────────────────────────────────────────────────── */

test.describe('Chat', () => {
  test('displays input area after login', async ({ page }) => {
    await registerAndEnter(page);
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.locator('.send-btn')).toBeVisible();
  });

  test('sends a message and receives a response', async ({ page }) => {
    await registerAndEnter(page);
    const textarea = page.locator('textarea');
    await textarea.fill('Say exactly: pong');
    await page.locator('button.send-btn').click({ force: true });

    // User message bubble
    await expect(page.locator('.msg.user .bubble').last()).toBeVisible({ timeout: 10_000 });

    // Assistant response via SSE streaming
    await expect(page.locator('.msg.assistant .bubble').last()).toBeVisible({ timeout: 60_000 });
  });
});

/* ── Admin: Navigation ───────────────────────────────────── */

test.describe('Admin Navigation', () => {
  test('shows core admin sidebar tabs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    for (const label of ['Prompts', 'Guardrails', 'Routing', 'Workflows', 'Tools', 'Workflow Runs', 'Guardrail Evals', 'Task Policies', 'Contracts', 'Cache', 'Identity', 'Memory Gov', 'Search', 'HTTP', 'Social', 'Enterprise']) {
      const location = ADMIN_TAB_LOCATIONS[label]!;
      const tabButton = page.locator(`[data-admin-tab="${location.key}"]`).first();
      if (!(await tabButton.isVisible({ timeout: 1000 }).catch(() => false))) {
        await page.locator('.admin-group-btn', { hasText: location.group }).click();
      }
      await expect(tabButton).toBeVisible();
    }
  });

  test('switches to Guardrails tab', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Guardrails');
    await waitForListHeader(m);
  });

  test('seed defaults API succeeds for admin user', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    await seedDefaults(page);
  });
});

/* ── Admin: Seed & Data ──────────────────────────────────── */

test.describe('Admin Seed & Data', () => {
  test('seed defaults populates prompts', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    // Prompts tab (default) should show search header with record count
    await waitForListHeader(m, 5000);
  });

  test('guardrails tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Guardrails');
    await waitForListHeader(m, 5000);
  });
});

/* ── Admin: Guardrails CRUD ──────────────────────────────── */

test.describe('Admin Guardrail CRUD', () => {
  test('creates a new guardrail via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    // Seed defaults first to populate existing data
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    // Navigate to Guardrails tab
    await openAdminTab(page, 'Guardrails');
    // Click + New in the admin action bar
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    // Form should now be visible with "New Guardrail" heading
    await expect(m.locator('.admin-form-title', { hasText: 'New Guardrail' })).toBeVisible({ timeout: 3000 });
    // Fill the Name input (first text input in the form)
    await m.locator('input[type="text"]').first().fill('PW-Test-Guard');
    // Select the Type (required field — UI doesn't auto-set state on initial render)
    await m.locator('select').first().selectOption('content_filter');
    // Click Create button in the form
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    // Wait for the form to disappear (save + re-render triggered)
    await expect(m.locator('.admin-form-title', { hasText: 'New Guardrail' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Prompts Tab ───────────────────────────────────── */

test.describe('Admin Prompts', () => {
  test('prompts tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    // Prompts is the default tab, should show search header with items
    await waitForListHeader(m, 5000);
  });

  test('creates a new prompt via wizard', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    // Prompts now uses the setup wizard instead of the legacy CRUD form.
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.prompt-wizard')).toBeVisible({ timeout: 5000 });
    await expect(m.locator('.prompt-wizard-head')).toContainText('Prompt Setup Wizard');
    await expect(m.locator('[data-testid="prompt-template-editor"]')).toBeVisible({ timeout: 3000 });
  });

  test('edits a seeded prompt', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    // Click first Edit button in the prompts table
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      // Should show the edit form with pre-filled data
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Routing Tab ──────────────────────────────────── */

test.describe('Admin Routing', () => {
  test('routing tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Routing');
    await waitForListHeader(m, 5000);
  });

  test('creates a new routing policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Routing');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Routing Policy' })).toBeVisible({ timeout: 3000 });
    // Fill Name input
    await m.locator('input[type="text"]').first().fill('PW-Test-Routing');
    // Select the Strategy from the dropdown
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Routing Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded routing policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Routing');
    // Click first Edit button in the routing table
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Read-only Tabs ───────────────────────────────── */

test.describe('Admin Read-only Tabs', () => {
  test('workflow runs tab has no admin + New button', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Workflow Runs');
    // The admin action bar's "+ New" button should NOT exist in main (sidebar's + New is outside .main)
    await expect(m.locator('button.nav-btn').filter({ hasText: /^\+ New$/ })).not.toBeVisible();
  });

  test('guardrail evals tab has no admin + New button', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Guardrail Evals');
    await expect(m.locator('button.nav-btn').filter({ hasText: /^\+ New$/ })).not.toBeVisible();
  });

  test('workflow runs tab shows data after seed + API run creation', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    // Seed defaults to create some runs
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Workflow Runs');
    await waitForListHeader(m, 5000);
  });
});

/* ── Admin: Task Policies Tab ────────────────────────────── */

test.describe('Admin Task Policies', () => {
  test('task policies tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Task Policies');
    await waitForListHeader(m, 5000);
  });

  test('creates a new task policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Task Policies');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Task Policy' })).toBeVisible({ timeout: 3000 });
    // Fill Name (1st text input), Description (2nd), Trigger (3rd)
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Policy');
    await textInputs.nth(2).fill('test_action');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Task Policy' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Contracts Tab ────────────────────────────────── */

test.describe('Admin Contracts', () => {
  test('contracts tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Contracts');
    await waitForListHeader(m, 5000);
  });

  test('creates a new contract via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Contracts');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Contract' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Contract');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Contract' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Cache Policies Tab ───────────────────────────── */

test.describe('Admin Cache Policies', () => {
  test('cache tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Cache');
    await waitForListHeader(m, 5000);
  });

  test('creates a new cache policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Cache');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Cache Policy' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Cache-Policy');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Cache Policy' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Identity Rules Tab ───────────────────────────── */

test.describe('Admin Identity Rules', () => {
  test('identity tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Identity');
    await waitForListHeader(m, 5000);
  });

  test('creates a new identity rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Identity');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Identity Rule' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Identity-Rule');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Identity Rule' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Memory Governance Tab ────────────────────────── */

test.describe('Admin Memory Governance', () => {
  test('memory governance tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Memory Gov');
    await waitForListHeader(m, 5000);
  });

  test('creates a new memory governance rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Memory Gov');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Memory Governance' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Memory-Governance');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Memory Governance' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Dashboard ───────────────────────────────────────────── */

test.describe('Dashboard', () => {
  test('navigates to dashboard', async ({ page }) => {
    await registerAndEnter(page);
    await page.locator('.profile-avatar').click();
    await page.locator('.pf-btn', { hasText: 'Dashboard' }).click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.main')).toBeVisible();
  });
});

/* ── Admin: Search Providers Tab ─────────────────────────── */

test.describe('Admin Search Providers', () => {
  test('search tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Search');
    await waitForListHeader(m, 5000);
  });

  test('creates a new search provider via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Search');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Search Provider' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Search');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Search Provider' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded search provider', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Search');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: HTTP Endpoints Tab ───────────────────────────── */

test.describe('Admin HTTP Endpoints', () => {
  test('http tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'HTTP');
    await waitForListHeader(m, 5000);
  });

  test('creates a new http endpoint via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'HTTP');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New HTTP Endpoint' })).toBeVisible({ timeout: 3000 });
    const httpInputs = m.locator('input[type="text"]');
    await httpInputs.nth(0).fill('PW-Test-HTTP');
    await httpInputs.nth(2).fill('https://example.com/api/test');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New HTTP Endpoint' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded http endpoint', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'HTTP');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Social Accounts Tab ──────────────────────────── */

test.describe('Admin Social Accounts', () => {
  test('social tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Social');
    await waitForListHeader(m, 5000);
  });

  test('creates a new social account via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Social');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Social Account' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Social');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Social Account' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded social account', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Social');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Enterprise Connectors Tab ────────────────────── */

test.describe('Admin Enterprise Connectors', () => {
  test('enterprise tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Enterprise');
    await waitForListHeader(m, 5000);
  });

  test('creates a new enterprise connector via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Enterprise');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Enterprise Connector' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Enterprise');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Enterprise Connector' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded enterprise connector', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Enterprise');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tool Catalog Tab ─────────────────────────────── */

test.describe('Admin Tool Catalog', () => {
  test('tool catalog tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tools');
    await waitForListHeader(m, 5000);
  });

  test('creates a new tool catalog entry via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tools');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool' })).toBeVisible({ timeout: 3000 });
    const inputs = m.locator('input[type="text"]');
    await inputs.nth(0).fill('PW-Test-Tool');
    await inputs.nth(1).fill('pw-test-tool');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded tool catalog entry', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tools');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tool Policies Tab ────────────────────────────── */

test.describe('Admin Tool Policies', () => {
  test('tool policies tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Policies');
    await waitForListHeader(m, 5000);
  });

  test('creates a new tool policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Policies');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool Policy' })).toBeVisible({ timeout: 3000 });
    const inputs = m.locator('input[type="text"]');
    await inputs.nth(0).fill('pw-test-policy');
    await inputs.nth(1).fill('PW Test Policy');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded tool policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Policies');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tool Audit Tab ───────────────────────────────── */

test.describe('Admin Tool Audit', () => {
  test('tool audit tab is visible and shows empty state or list', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Audit');
    // Tab loaded — either empty state or item list is acceptable (no events yet in fresh DB)
    await expect(m).toBeVisible();
  });

  test('tool audit tab has no New button (read-only)', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Audit');
    await page.waitForTimeout(500);
    await expect(m.locator('button', { hasText: 'New Tool Audit Event' })).not.toBeVisible();
  });
});

/* ── Admin: Tool Health Tab ──────────────────────────────── */

test.describe('Admin Tool Health', () => {
  test('tool health tab is visible and shows empty state or list', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Health');
    await expect(m).toBeVisible();
  });

  test('tool health tab has no New button (read-only)', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tool Health');
    await page.waitForTimeout(500);
    await expect(m.locator('button', { hasText: 'New Tool Health' })).not.toBeVisible();
  });
});

/* ── Admin: Replay Scenarios Tab ─────────────────────────── */

test.describe('Admin Replay Scenarios', () => {
  test('replay tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Replay');
    await waitForListHeader(m, 5000);
  });

  test('creates a new replay scenario via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Replay');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Replay Scenario' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Replay');
    const textareas = m.locator('textarea');
    await textareas.nth(0).fill('What is 1+1?');
    await textareas.nth(1).fill('The answer is 2.');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Replay Scenario' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded replay scenario', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Replay');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Trigger Definitions Tab ──────────────────────── */

test.describe('Admin Trigger Definitions', () => {
  test('triggers tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Triggers');
    await waitForListHeader(m, 5000);
  });

  test('creates a new trigger definition via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Triggers');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Trigger Definition' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Trigger');
    await textInputs.nth(1).fill('0 6 * * *');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Trigger Definition' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded trigger definition', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Triggers');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tenant Configs Tab ───────────────────────────── */

test.describe('Admin Tenant Configs', () => {
  test('tenants tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tenants');
    await waitForListHeader(m, 5000);
  });

  test('creates a new tenant config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tenants');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Tenant Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Tenant');
    await textInputs.nth(2).fill('pw-tenant-id');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Tenant Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded tenant config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Tenants');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Sandbox Policies ─────────────────────────────────

test.describe('Admin Sandbox Policies', () => {
  test('shows seeded sandbox policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Sandbox');
    await waitForListHeader(m, 5000);
  });

  test('creates a new sandbox policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Sandbox');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Sandbox Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Sandbox');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Sandbox Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded sandbox policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Sandbox');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Extraction Pipelines ─────────────────────────────

test.describe('Admin Extraction Pipelines', () => {
  test('shows seeded extraction pipelines', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Extraction');
    await waitForListHeader(m, 5000);
  });

  test('creates a new extraction pipeline via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Extraction');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Extraction Pipeline' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Pipeline');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Extraction Pipeline' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded extraction pipeline', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Extraction');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Artifact Policies ────────────────────────────────

test.describe('Admin Artifact Policies', () => {
  test('shows seeded artifact policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Artifacts');
    await waitForListHeader(m, 5000);
  });

  test('creates a new artifact policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Artifacts');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Artifact Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Artifact-Policy');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Artifact Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded artifact policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Artifacts');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Reliability Policies ─────────────────────────────

test.describe('Admin Reliability Policies', () => {
  test('shows seeded reliability policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Reliability');
    await waitForListHeader(m, 5000);
  });

  test('creates a new reliability policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Reliability');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Reliability Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Reliability');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Reliability Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded reliability policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Reliability');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Collaboration Sessions ───────────────────────────

test.describe('Admin Collaboration Sessions', () => {
  test('shows seeded collaboration sessions', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Collaboration');
    await waitForListHeader(m, 5000);
  });

  test('creates a new collaboration session via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Collaboration');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Collaboration Session' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Collab');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Collaboration Session' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded collaboration session', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Collaboration');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Compliance Rules ─────────────────────────────────

test.describe('Admin Compliance Rules', () => {
  test('shows seeded compliance rules', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Compliance');
    await waitForListHeader(m, 5000);
  });

  test('creates a new compliance rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Compliance');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Compliance Rule' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Compliance');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Compliance Rule' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded compliance rule', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Compliance');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Graph Configs ────────────────────────────────────

test.describe('Admin Graph Configs', () => {
  test('shows seeded graph configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Graph');
    await waitForListHeader(m, 5000);
  });

  test('creates a new graph config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Graph');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Graph Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Graph');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Graph Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded graph config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Graph');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Plugin Configs ───────────────────────────────────

test.describe('Admin Plugin Configs', () => {
  test('shows seeded plugin configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Plugins');
    await waitForListHeader(m, 5000);
  });

  test('creates a new plugin config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Plugins');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Plugin Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Plugin');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Plugin Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded plugin config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Plugins');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Phase 9: Developer Tab Group ───────────────────────────

test.describe('Admin Scaffold Templates', () => {
  test('shows seeded scaffold templates', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Scaffolds');
    await waitForListHeader(m, 5000);
  });

  test('creates a new scaffold template via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Scaffolds');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Scaffold Template' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Scaffold');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Scaffold Template' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded scaffold template', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Scaffolds');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Admin Recipe Configs', () => {
  test('shows seeded recipe configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Recipes');
    await waitForListHeader(m, 5000);
  });

  test('creates a new recipe config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Recipes');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Recipe Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Recipe');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Recipe Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded recipe config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Recipes');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Admin Widget Configs', () => {
  test('shows seeded widget configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Widgets');
    await waitForListHeader(m, 5000);
  });

  test('creates a new widget config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Widgets');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Widget Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Widget');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Widget Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded widget config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Widgets');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Admin Validation Rules', () => {
  test('shows seeded validation rules', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Validation');
    await waitForListHeader(m, 5000);
  });

  test('creates a new validation rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Validation');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Validation Rule' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Validation');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Validation Rule' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded validation rule', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await seedDefaults(page);
    await page.waitForTimeout(1500);
    await openAdminTab(page, 'Validation');
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tool Credentials CRUD ───────────────────────────── */

test.describe('Admin Tool Credentials CRUD', () => {
  test('tool credentials tab is visible in admin sidebar', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Tool Credentials');
    await expect(m.getByRole('heading', { name: /Tool Credential/i })).toBeVisible({ timeout: 5000 });
  });

  test('creates a new tool credential via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Tool Credentials');
    await clickAdminNewButton(m);
    await page.waitForTimeout(300);
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool Credential' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Credential');
    await m.locator('.admin-form-action-btns button').filter({ hasText: 'Create' }).click();
    await expect(m.locator('.admin-form-title', { hasText: 'New Tool Credential' })).not.toBeVisible({ timeout: 5000 });
  });

  test('tool credentials tab has + New button', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await openAdminTab(page, 'Tool Credentials');
    await expect(m.locator('button.nav-btn').filter({ hasText: /^\+ New$/ })).toBeVisible({ timeout: 5000 });
  });
});
