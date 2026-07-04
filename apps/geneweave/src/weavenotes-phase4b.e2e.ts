/**
 * Playwright E2E — weaveNotes Phase 4 (creative EXPANSION): illustrations, images, the auto router.
 * Proves, against a live server + a real LLM:
 *   • API: create_illustration makes a sanitised SVG ILLUSTRATION (a real picture — e.g. a heart) →
 *     suggestion + artifact → accept embeds it as an inert image (no <script>). create_visual with
 *     kind="auto" picks the right kind. Image generation is CONFIG-GATED (off by default → refused;
 *     the flag persists + is Builder-editable). The new tools + the agent are registered.
 *   • UI: a note renders an SVG illustration as an image; the selection card's "✦ Visualize" picker
 *     (auto / diagram / illustration / ink / image) draws + the result renders. Screenshots captured.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase4b
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn4b-owner@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
const PARA = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
// A heart SVG illustration already embedded in a note (for the deterministic render test).
const HEART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 80 C 20 55, 10 30, 30 20 C 42 13, 50 25, 50 30 C 50 25, 58 13, 70 20 C 90 30, 80 55, 50 80 Z" fill="#F4C0D1" stroke="#A8281F" stroke-width="2"/></svg>';
const HEART_URI = `data:image/svg+xml;base64,${Buffer.from(HEART_SVG, 'utf8').toString('base64')}`;

// ── API: SVG illustration, auto router, config gating, registration (real LLM) ──────
test('Phase 4b — illustration (sanitised SVG), auto router, image-gen gating, tools registered', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Anatomy', doc_json: PARA('The human heart has four chambers and pumps blood through the body.') } })).json() as { id: string };

  // create_illustration → an SVG picture, embedded as an inert image, with no script.
  const ill = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/illustration`, { headers: hdr, data: { instruction: 'Draw a simple labelled illustration of a human heart.' } })).json() as { ok: boolean; suggestionId: string; artifactId: string | null };
  expect(ill.ok).toBe(true); expect(ill.artifactId).toBeTruthy();
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${ill.suggestionId}/accept`, { headers: hdr, data: {} });
  const doc = (await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string }).doc_json;
  expect(doc).toContain('"type":"image"');
  expect(doc).toContain('data:image/svg+xml');
  expect(doc).not.toContain('<script'); // sanitised

  // create_visual (auto) on a process description → the AI should pick a DIAGRAM.
  const vis = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/visual`, { headers: hdr, data: { instruction: 'a flowchart of the steps: deoxygenated blood enters, lungs oxygenate it, it returns, the body receives it', kind: 'auto' } })).json() as { ok: boolean; kind?: string };
  // eslint-disable-next-line no-console
  console.log(`[wn4b] auto-visual kind=${vis.kind}`);
  expect(vis.ok).toBe(true);
  expect(['diagram', 'illustration']).toContain(vis.kind); // a flow → diagram (illustration acceptable fallback)

  // SECURITY/GATING: image generation is OFF by default → /ai/image is refused with a clear message.
  const img = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/image`, { headers: hdr, data: { instruction: 'a photo of a heart' } });
  const imgData = await img.json() as { ok: boolean; error?: string };
  expect(imgData.ok).toBe(false);
  expect(String(imgData.error)).toContain('disabled');

  // The flag is DB-backed + Builder-editable (toggling persists).
  const get1 = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(get1['weavenotes-settings'][0]!['image_generation_enabled']).toBe(0);
  expect(get1['weavenotes-settings'][0]!['illustration_enabled']).toBe(1);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { illustration_enabled: false } });
  const got = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(got['weavenotes-settings'][0]!['illustration_enabled']).toBe(0);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { illustration_enabled: true } }); // restore

  // The new creative tools + the agent are registered.
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  const keys = (tools.tools ?? []).map((t) => t.tool_key);
  expect(keys).toEqual(expect.arrayContaining(['create_illustration', 'generate_image', 'create_visual']));
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('create_visual');
});

// ── UI: a note renders an SVG illustration; the Visualize picker draws + renders ────
test('Phase 4b — UI: an SVG illustration renders; the card Visualize picker works', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'My heart sketch:' }] }, { type: 'image', attrs: { author: 'ai', alt: 'human heart', src: HEART_URI } }] };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Heart note', doc_json: doc } })).json() as { id: string };

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Heart note', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  // The SVG illustration rendered as an (AI-framed) image.
  const img = page.locator('.gw-image img');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toContain('data:image/svg+xml');
  await page.screenshot({ path: `${SHOT}/gw-wn4b-illustration.png` });

  // The selection card's Visualize picker is present + can draw an illustration.
  await page.evaluate(() => {
    const p = document.querySelector('.notes-editor-mount .ProseMirror p'); const node = p?.firstChild;
    if (!p || !node || !node.textContent) return;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.textContent.length);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    document.querySelector('.notes-editor-mount')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('.notes-aicard-pill').click({ timeout: 5000 });
  await expect(page.locator('.notes-aicard-visual')).toBeVisible();
  await page.locator('.notes-aicard-visual select').selectOption('illustration');
  await page.screenshot({ path: `${SHOT}/gw-wn4b-card.png` });
  await page.locator('.notes-aicard-visual .notes-aicard-create').click();
  await expect(page.locator('.notes-aicard-status')).toContainText('Suggestion ready', { timeout: 40000 });
  await page.locator('.notes-diff-accept').first().click();
  await page.waitForTimeout(1500);
  // Now there are at least two images (the seed heart + the new illustration).
  expect(await page.locator('.gw-image img').count()).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOT}/gw-wn4b-drawn.png` });
});
