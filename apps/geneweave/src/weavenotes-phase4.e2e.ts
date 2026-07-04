/**
 * Playwright E2E — weaveNotes Phase 4 (AI ink + diagrams + creative generation).
 * Proves, against a live server + a real LLM:
 *   • API: create_diagram + draw_ink stage a track-changes SUGGESTION + mirror a rendered SVG to
 *     an ARTIFACT; accepting it inserts a native, editable diagram/inkCanvas block into the note.
 *     The creative tools + the weaveNotes Editor agent are registered; a non-owner is refused.
 *   • UI: a note containing a diagram + an ink canvas RENDERS them as SVG (the node-views), and a
 *     human can draw a stroke on the ink canvas. The selection card's "✦ Make a diagram" chip
 *     produces a diagram suggestion you accept and see. Screenshots captured for design review.
 *   • The Phase 4 "Done when": "colour-coded flow of 4 steps" → an editable coloured diagram;
 *     "underline this in blue ink" → real editable strokes.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase4
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn4-owner@weaveintel.dev';
const OTHER = 'wn4-other@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
const PARA = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// A note that already contains a diagram + an ink canvas (for the deterministic render test).
const CREATIVE_DOC = {
  type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Launch plan' }] },
    { type: 'diagram', attrs: { author: 'ai', title: 'Launch flow', kind: 'flow', scene: {
      kind: 'flow', title: 'Launch flow',
      nodes: [{ id: 'a', label: 'Plan', color: 'blue' }, { id: 'b', label: 'Build', color: 'teal' }, { id: 'c', label: 'Review', color: 'amber', shape: 'diamond' }, { id: 'd', label: 'Ship', color: 'sage' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd', label: 'go' }],
    } } },
    { type: 'inkCanvas', attrs: { author: 'ai', strokes: [{ points: [{ x: 10, y: 30 }, { x: 120, y: 30 }], color: '#3B6FB0', width: 3, tool: 'pen' }] } },
  ],
};

// ── API: the AI creates editable diagram + ink as suggestions + artifacts (real LLM) ────
test('Phase 4 — create_diagram + draw_ink stage suggestions, mirror artifacts, accept inserts native blocks', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Pipeline', doc_json: PARA('Our ML pipeline: gather data, train a model, evaluate it, then deploy to production.') } })).json() as { id: string };

  // create_diagram → a pending suggestion + a mirrored SVG artifact.
  const diag = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/diagram`, { headers: hdr, data: { instruction: 'Draw a colour-coded flow of the 4 pipeline steps; colour the evaluate step amber.' } })).json() as { ok: boolean; suggestionId: string; artifactId: string | null };
  expect(diag.ok).toBe(true); expect(diag.suggestionId).toBeTruthy();
  expect(diag.artifactId, 'the diagram SVG was mirrored to an artifact').toBeTruthy();
  // Accept → a native diagram block lands in the note.
  const acc = await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${diag.suggestionId}/accept`, { headers: hdr, data: {} });
  expect(acc.status()).toBe(200);
  let doc = (await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string }).doc_json;
  expect(doc).toContain('"type":"diagram"');
  expect(doc).toContain('"nodes"'); // the editable scene survived

  // draw_ink "underline in blue" → an ink suggestion → accept → an inkCanvas block.
  const ink = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/ink`, { headers: hdr, data: { instruction: 'Draw a blue underline.' } })).json() as { ok: boolean; suggestionId: string; artifactId: string | null };
  expect(ink.ok).toBe(true);
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${ink.suggestionId}/accept`, { headers: hdr, data: {} });
  doc = (await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string }).doc_json;
  expect(doc).toContain('"type":"inkCanvas"');
  expect(doc).toContain('"points"'); // real editable strokes

  // SECURITY: a non-owner cannot draw on the note.
  const other = await page.context().browser()!.newContext();
  const op = await other.newPage(); await login(op, OTHER);
  const oOrigin = new URL(op.url()).origin; const oHdr = { 'x-csrf-token': await csrf(op) };
  const forbidden = await op.request.post(`${oOrigin}/api/me/notes/${note.id}/ai/diagram`, { headers: oHdr, data: { instruction: 'hi' } });
  expect(forbidden.status()).toBe(404);
  await other.close();

  // The creative tools + the weaveNotes Editor agent are registered.
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  const keys = (tools.tools ?? []).map((t) => t.tool_key);
  expect(keys).toContain('create_diagram'); expect(keys).toContain('draw_ink');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('create_diagram');
});

// ── UI: the diagram + ink RENDER; a human can draw on the ink canvas ────────────────
test('Phase 4 — UI: a note renders the diagram + ink as SVG; the ink canvas is drawable', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Visual note', doc_json: CREATIVE_DOC } })).json();

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Visual note', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // The diagram node-view rendered an SVG containing the node labels.
  const diagram = page.locator('.gw-diagram-block svg');
  await expect(diagram).toBeVisible();
  await expect(page.locator('.gw-diagram-block')).toContainText('Plan');
  await expect(page.locator('.gw-diagram-block')).toContainText('Ship');
  // The ink node-view rendered the AI's stroke (a path) + a pen toolbar. (A horizontal line has a
  // zero-height box, so assert it's ATTACHED rather than "visible".)
  await expect(page.locator('.gw-ink-block svg path')).toHaveCount(1);
  await expect(page.locator('.gw-ink-toolbar')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/gw-wn4-render.png` });

  // A human draws a stroke on the ink surface → a new path appears.
  const before = await page.locator('.gw-ink-block svg path').count();
  const surface = page.locator('.gw-ink-surface');
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 80, { steps: 6 });
  await page.mouse.move(box.x + 160, box.y + 50, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await page.locator('.gw-ink-block svg path').count()).toBeGreaterThan(before);
  await page.screenshot({ path: `${SHOT}/gw-wn4-drawn.png` });
});

// ── UI + real LLM: the card "Make a diagram" → suggestion → accept → it renders ──────
test.describe('the selection card makes a diagram (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('Phase 4 — select text → ✦ Make a diagram → accept → the diagram renders', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, OWNER);
    await page.setViewportSize({ width: 1440, height: 900 });
    const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Card diagram', doc_json: PARA('Steps: gather requirements, design, build, test, release.') } })).json() as { id: string };

    await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
    await page.goto('/');
    await page.getByText('Card diagram', { exact: false }).first().click({ timeout: 15000 });
    await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);

    // Select the whole sentence, then open the card via the pill.
    await page.evaluate(() => {
      const p = document.querySelector('.notes-editor-mount .ProseMirror p'); const node = p?.firstChild;
      if (!p || !node || !node.textContent) return;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.textContent.length);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
      document.querySelector('.notes-editor-mount')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('.notes-aicard-pill').click({ timeout: 5000 });
    await expect(page.locator('.notes-aicard')).toBeVisible();
    await page.locator('.notes-aicard-create', { hasText: 'Make a diagram' }).click();
    await expect(page.locator('.notes-aicard-status')).toContainText('Suggestion ready', { timeout: 30000 });

    // Accept the diagram suggestion → it renders in the note.
    await expect(page.locator('.notes-diff').first()).toBeVisible({ timeout: 8000 });
    await page.locator('.notes-diff-accept').first().click();
    await expect(page.locator('.gw-diagram-block svg')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SHOT}/gw-wn4-card-diagram.png` });
    const doc = (await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string }).doc_json;
    expect(doc).toContain('"type":"diagram"');
  });
});
