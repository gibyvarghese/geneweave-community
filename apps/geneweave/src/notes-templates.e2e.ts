/**
 * Playwright E2E — Note templates gallery: rich catalogue, categories, branded icons, search, scroll.
 *
 *  • API: GET /api/me/notes/templates returns the expanded catalogue (Solution Architecture, Customer Journey,
 *    Design Document, PRD, etc.) across many categories.
 *  • UI: the gallery groups templates by category with the app's branded line-icons (SVG, not emoji); it
 *    SCROLLS (it used not to); a search box filters templates live; picking one creates a note from it.
 * Run: npm run test:e2e -- notes-templates   (no LLM needed).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'tmpl-owner@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });
}

test('templates — API returns the expanded catalogue across categories', async ({ page }) => {
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const data = await (await page.request.get(`${origin}/api/me/notes/templates`)).json() as { templates: Array<{ template_key?: string; title: string; category: string }> };
  const keys = data.templates.map((t) => t.template_key);
  expect(data.templates.length).toBeGreaterThanOrEqual(28);
  for (const k of ['solution-architecture', 'customer-journey', 'design-doc', 'prd', 'adr', 'retro', 'okrs', 'swot', 'how-to', 'postmortem']) {
    expect(keys, `template ${k} should be seeded`).toContain(k);
  }
  const cats = new Set(data.templates.map((t) => t.category));
  for (const c of ['Engineering', 'Product', 'Design', 'Meetings', 'Planning', 'Knowledge']) {
    expect([...cats], `category ${c}`).toContain(c);
  }
});

test('templates — gallery: branded icons, search, scroll, and start-from-template', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  // Open the gallery via the "templates" affordance next to + New note.
  await page.locator('.gw-newnote-tmpl').click();
  const gallery = page.locator('.notes-templates');
  await expect(gallery).toBeVisible({ timeout: 15000 });

  // Many cards, grouped into several categories.
  const cards = page.locator('.notes-template-card');
  const totalCards = await cards.count();
  expect(totalCards).toBeGreaterThanOrEqual(28);
  expect(await page.locator('.notes-template-cat').count()).toBeGreaterThanOrEqual(6);
  // Every card icon is an inline SVG (branded), none are emoji text.
  expect(await page.locator('.notes-template-icon svg').count()).toBe(totalCards);
  // Representative new templates are present.
  await expect(page.locator('.notes-template-title').getByText('Solution architecture document', { exact: true })).toBeVisible();
  await expect(page.locator('.notes-template-title').getByText('Customer journey map', { exact: true })).toBeVisible();
  await expect(page.locator('.notes-template-title').getByText('Design document', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/templates-gallery.png', fullPage: false });

  // The gallery SCROLLS (content taller than the viewport), and scrolling moves it.
  const scrollInfo = await gallery.evaluate((el) => ({ scrollable: el.scrollHeight > el.clientHeight + 20 }));
  expect(scrollInfo.scrollable, 'gallery should be taller than its viewport (scrollable)').toBe(true);
  await gallery.evaluate((el) => { el.scrollTop = 400; });
  expect(await gallery.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);

  // Search filters live.
  await gallery.evaluate((el) => { el.scrollTop = 0; });
  await page.locator('.notes-templates-search').fill('meeting');
  const afterSearch = await page.locator('.notes-template-card').count();
  expect(afterSearch).toBeGreaterThan(0);
  expect(afterSearch).toBeLessThan(totalCards); // filtered down
  // A non-matching query shows the empty state.
  await page.locator('.notes-templates-search').fill('zzznotathing');
  await expect(page.locator('.notes-templates-noresult')).toBeVisible();

  // Narrow to the Solution Architecture template by searching, then start a note from it.
  await page.locator('.notes-templates-search').fill('solution architecture');
  const solCard = page.locator('.notes-template-card').filter({ hasText: 'Solution architecture document' });
  await expect(solCard).toBeVisible({ timeout: 8000 });
  await solCard.click();
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.notes-editor-mount')).toContainText('Solution architecture', { timeout: 8000 });
});
