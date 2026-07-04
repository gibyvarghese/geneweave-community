/**
 * Visual validation — the hand-drawn upgrades: Creative theme (handwriting + dotted paper),
 * SKETCH diagrams (Rough.js-style), and real TABLES. Creates rich notes and screenshots them so the
 * output can be compared to the attached sample images.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-creative-visual
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'creative-visual@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

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

const cell = (text: string, header = false) => ({ type: header ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
const row = (cells: { type: string; content: unknown[] }[]) => ({ type: 'tableRow', content: cells });

// Science note — handwriting Creative theme + two SKETCH diagrams + bullets + a callout.
const SCIENCE = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Science — Chapter 1' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Matter' }] },
  { type: 'bulletList', content: ['Anything that has mass and occupies space.', 'Made up of tiny particles.'].map((tx) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: tx }] }] })) },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'States of Matter' }] },
  { type: 'diagram', attrs: { kind: 'mindmap', scene: { kind: 'mindmap', nodes: [{ id: 'm', label: 'Matter' }, { id: 's', label: 'Solid' }, { id: 'l', label: 'Liquid' }, { id: 'g', label: 'Gas' }, { id: 'p', label: 'Plasma' }], edges: [{ from: 'm', to: 's' }, { from: 'm', to: 'l' }, { from: 'm', to: 'g' }, { from: 'm', to: 'p' }] } } },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Change of State' }] },
  { type: 'diagram', attrs: { kind: 'flow', scene: { kind: 'flow', nodes: [{ id: 'so', label: 'Solid' }, { id: 'li', label: 'Liquid' }, { id: 'ga', label: 'Gas' }], edges: [{ from: 'so', to: 'li', label: 'melting' }, { from: 'li', to: 'ga', label: 'boiling' }] } } },
  { type: 'callout', attrs: { tone: 'tip' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Latent heat: absorbed/released during a change of state while temperature stays constant.' }] }] },
] });

// Meeting minutes — Creative theme + a real bordered TABLE for the action items.
const MEETING = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Meeting Minutes' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Objective: discuss the exhibition layout process. Oct 10 2023 · Conference Room 2.' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Action items' }] },
  { type: 'table', content: [
    row([cell('ACTION ITEM', true), cell('DELEGATED TO', true), cell('DEADLINE', true), cell('✓', true)]),
    row([cell('Compare sales data to select best-selling products'), cell('Toby'), cell('Oct 11'), cell('✓')]),
    row([cell('Warehouse staff mail out trade-show products'), cell('Tim'), cell('Oct 12'), cell('✓')]),
    row([cell('Company business card production'), cell('Lisa'), cell('Oct 14'), cell('')]),
    row([cell('Product introduction for simulated exhibitions'), cell('Monica'), cell('Oct 14'), cell('')]),
  ] },
] });

async function makeAndOpen(page: Page, title: string, docJson: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  // page_theme:'creative' so it opens in the hand-drawn theme.
  await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title, doc_json: docJson, page_theme: 'creative' } });
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText(title, { exact: true }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  // Ensure Creative theme is active (the toggle).
  const creativeTab = page.getByRole('button', { name: /^Creative$/ }).first();
  if (await creativeTab.count()) await creativeTab.click().catch(() => {});
  await page.waitForTimeout(1500);
}

test('Visual — Science note: Creative theme + hand-drawn (sketch) diagrams', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1320, height: 1200 });
  await makeAndOpen(page, 'Science — Chapter 1', SCIENCE);
  // The diagram should render hand-drawn (the sketch SVG class).
  await expect(page.locator('.gw-diagram.sketch, .gw-diagram-block svg').first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-creative-science.png`, fullPage: true });
});

test('Visual — Meeting minutes: Creative theme + a real bordered table', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1320, height: 1000 });
  await makeAndOpen(page, 'Meeting Minutes', MEETING);
  await expect(page.locator('.gw-table, table').first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-creative-meeting.png`, fullPage: true });
});
