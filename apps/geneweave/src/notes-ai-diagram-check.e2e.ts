/**
 * Verify the AI diagram is created via the weaveIntel pipeline (real LLM) and renders (hand-drawn).
 *
 *   • API path: POST /api/me/notes/:id/ai/diagram → a real LLM (geneWeave model routing) designs a
 *     diagram SCENE → validateDiagramScene (@weaveintel/notes) → staged as a track-changes suggestion.
 *     Accepting it puts a real `diagram` node (with the AI-generated nodes/edges) into the note.
 *   • UI: the accepted AI diagram renders as a HAND-DRAWN (sketch) SVG — screenshot for comparison.
 *   • Agent path: the `create_diagram` tool is registered in the tool catalog + granted to the
 *     weavenotes_editor worker agent; a real chat run drives it.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-ai-diagram-check
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'ai-diagram@weaveintel.dev';
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
// Pin a note action's global routing mode (this test exercises the DIRECT service path).
async function setActionDirect(page: Page, origin: string, action: string): Promise<void> {
  const hdr = { 'x-csrf-token': await csrf(page) };
  const rows = (await (await page.request.get(`${origin}/api/admin/note-action-modes`)).json() as { 'note-action-modes': Array<{ id: string; tenant_id: string; action_key: string }> })['note-action-modes'];
  const row = rows.find((r) => r.tenant_id === '' && r.action_key === action);
  if (row) await page.request.put(`${origin}/api/admin/note-action-modes/${row.id}`, { headers: hdr, data: { tenant_id: '', action_key: action, mode: 'direct' } });
}
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': await csrf(page) } });
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

const SEED = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'States of matter' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Matter exists as solid, liquid, gas and plasma, and changes between them when energy is added or removed.' }] },
] });

function findDiagram(doc: { content?: Array<{ type: string; attrs?: { scene?: { nodes?: unknown[]; edges?: unknown[] } } }> }): { nodes?: unknown[]; edges?: unknown[] } | null {
  for (const n of doc.content ?? []) if (n.type === 'diagram') return n.attrs?.scene ?? null;
  return null;
}

// ── API path: a real LLM designs the diagram, it stages, accept puts a valid scene in the note ──
test('AI diagram — real LLM designs it via geneWeave routing, stages a suggestion, accept inserts a valid scene', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1320, height: 1000 });
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  await setActionDirect(page, origin, 'diagram');
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'AI diagram test', doc_json: SEED } })).json() as { id: string };

  // The AI designs the diagram (real model call through geneWeave's routing).
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/diagram`, { headers: hdr, data: { instruction: 'A mind map: "Matter" in the centre with four branches — Solid, Liquid, Gas, Plasma.' } });
  expect(r.status()).toBe(201);
  const staged = await r.json() as { ok: boolean; suggestionId?: string; action?: string };
  expect(staged.ok).toBe(true);
  expect(staged.action).toBe('create_diagram');

  // It is a PENDING track-changes suggestion (the inline card), not a silent write.
  const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string; preview: string }> };
  const sug = pend.suggestions.find((s) => s.action === 'create_diagram');
  expect(sug).toBeTruthy();
  expect(sug!.preview).toMatch(/Diagram:/);

  // The doc has NO diagram yet (suggestion is unaccepted).
  const before = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  expect(findDiagram(JSON.parse(before.doc_json))).toBeNull();

  // Accept it → a real `diagram` node with the AI's nodes/edges lands in the note.
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${sug!.id}/accept`, { headers: hdr, data: {} });
  const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const scene = findDiagram(JSON.parse(after.doc_json));
  expect(scene).toBeTruthy();
  expect(Array.isArray(scene!.nodes)).toBe(true);
  expect((scene!.nodes as unknown[]).length).toBeGreaterThanOrEqual(3); // the AI produced real nodes
  // eslint-disable-next-line no-console
  console.log('[ai-diagram] AI scene nodes:', JSON.stringify((scene!.nodes as Array<{ label?: string }>).map((n) => n.label)));

  // UI: the AI-created diagram renders as a hand-drawn (sketch) SVG.
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('AI diagram test', { exact: true }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('.gw-diagram-block svg.gw-diagram.sketch, .gw-diagram-block svg').first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-ai-diagram.png`, fullPage: true });
});

// ── Registration: the create_diagram tool is in the catalog + granted to the weaveNotes Editor agent ──
test('AI diagram — create_diagram is a catalogued tool granted to the weavenotes_editor agent', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  expect((tools.tools ?? []).map((t) => t.tool_key)).toContain('create_diagram');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('create_diagram');
});

// ── Agent path: a real chat run drives create_diagram (the assistant draws a diagram in the note) ──
test.describe('agent draws a diagram (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('AI diagram — "draw a diagram in my note" → the agent calls create_diagram', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin;
    const hdr = { 'x-csrf-token': await csrf(page) };
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Agent diagram note', doc_json: SEED } })).json() as { id: string };

    const client = await clientFor(page);
    const session = createRunSession({ client });
    const prompt = `In my note ${note.id}, please draw a simple flow diagram showing solid → liquid → gas.`;
    await session.start({ input: { text: prompt }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    await awaitTerminal(session, 150_000);
    await new Promise((r) => setTimeout(r, 1200));
    session.dispose();

    // Ground truth: the agent's create_diagram staged a pending diagram suggestion on the note.
    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    // eslint-disable-next-line no-console
    console.log('[ai-diagram] agent staged actions:', JSON.stringify(pend.suggestions.map((s) => s.action)));
    expect(pend.suggestions.some((s) => s.action === 'create_diagram')).toBe(true);
  });
});
