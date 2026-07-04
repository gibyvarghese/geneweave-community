/**
 * weaveNotes — smart placement + whole-note restructure (real LLM, geneWeave routing).
 *
 *   • Smart placement: a diagram requested for a topic that lives in the MIDDLE of a note is
 *     inserted next to that section (not blindly appended at the end). The AI picks the anchor
 *     from the note's outline (pickAnchorAfter) before staging the suggestion.
 *   • Restructure: POST /api/me/notes/:id/ai/restructure reorganises the WHOLE note into a clear
 *     structure, staged as ONE track-changes suggestion; accepting it reorders the document while
 *     keeping every fact. An explicit outline drives the section order.
 *   • Registration: restructure_note is a catalogued tool granted to the weavenotes_editor agent,
 *     and a real chat run drives it.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-restructure-placement
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'restructure@weaveintel.dev';
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
// Pin a note action's global routing mode to 'direct' (these tests exercise the DIRECT service path:
// smart placement + restructure-to-outline). The agent-path tests below drive the chat agent directly.
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

const heading = (text: string, level = 2) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

// A note whose "Photosynthesis" section sits in the MIDDLE, with more sections after it.
const BIO = JSON.stringify({ type: 'doc', content: [
  heading('Biology revision', 1),
  heading('The cell'),
  para('The cell is the basic unit of life. It has a membrane, cytoplasm and a nucleus.'),
  heading('Respiration'),
  para('Respiration releases energy from glucose. Aerobic respiration uses oxygen.'),
  heading('Photosynthesis'),
  para('Photosynthesis converts light, water and carbon dioxide into glucose and oxygen in the chloroplast.'),
  heading('Genetics'),
  para('Genes are sections of DNA. Alleles are versions of a gene.'),
  heading('Ecology'),
  para('An ecosystem is the living and non-living things in an area and how they interact.'),
] });

function blockTypes(docJson: string): string[] {
  const doc = JSON.parse(docJson) as { content?: Array<{ type: string }> };
  return (doc.content ?? []).map((n) => n.type);
}
function diagramIndex(docJson: string): number {
  return blockTypes(docJson).indexOf('diagram');
}
function headingTexts(docJson: string): string[] {
  const doc = JSON.parse(docJson) as { content?: Array<{ type: string; content?: Array<{ text?: string }> }> };
  return (doc.content ?? []).filter((n) => n.type === 'heading').map((n) => (n.content ?? []).map((c) => c.text ?? '').join(''));
}

// ── Smart placement: the diagram lands by the Photosynthesis section, NOT at the very end ──
test.describe('smart placement (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('AI diagram for a middle section is inserted near it, not appended at the end', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin;
    const hdr = { 'x-csrf-token': await csrf(page) };
    await setActionDirect(page, origin, 'diagram');
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Bio placement', doc_json: BIO } })).json() as { id: string };

    const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/diagram`, { headers: hdr, data: { instruction: 'Draw a simple flow diagram of PHOTOSYNTHESIS: light + water + carbon dioxide → glucose + oxygen.' } });
    expect(r.status()).toBe(201);
    const staged = await r.json() as { ok: boolean; suggestionId?: string };
    expect(staged.ok).toBe(true);

    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string }> };
    const sug = pend.suggestions.find((s) => s.action === 'create_diagram');
    expect(sug).toBeTruthy();
    await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${sug!.id}/accept`, { headers: hdr, data: {} });

    const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
    const types = blockTypes(after.doc_json);
    const di = diagramIndex(after.doc_json);
    // eslint-disable-next-line no-console
    console.log('[placement] block order:', JSON.stringify(types), 'diagram at', di, 'of', types.length);
    expect(di).toBeGreaterThanOrEqual(0);
    // The Photosynthesis section is in the middle → a correctly-placed diagram is NOT the last block.
    expect(di).toBeLessThan(types.length - 1);
  });
});

// ── Restructure: reorganise the whole note to a desired outline, staged as one suggestion ──
test('AI restructure — reorganises the whole note to a desired outline, staged + accepted', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1320, height: 1100 });
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  await setActionDirect(page, origin, 'restructure');
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Bio restructure', doc_json: BIO, page_theme: 'creative' } })).json() as { id: string };

  const outline = 'Photosynthesis\nRespiration\nThe cell\nGenetics\nEcology';
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/restructure`, { headers: hdr, data: { outline } });
  expect(r.status()).toBe(201);
  const staged = await r.json() as { ok: boolean; suggestionId?: string; action?: string };
  expect(staged.ok).toBe(true);
  expect(staged.action).toBe('restructure_note');

  // It is a PENDING suggestion (the inline card), not a silent rewrite.
  const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string; before: string }> };
  const sug = pend.suggestions.find((s) => s.action === 'restructure_note');
  expect(sug).toBeTruthy();
  expect(sug!.before).toContain('Photosynthesis'); // the original was captured for the diff

  // The doc is unchanged until accepted.
  const before = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  expect(headingTexts(before.doc_json)[1]).toBe('The cell'); // still original order (after the H1)

  // Accept → the note is reorganised to the requested order, keeping all sections.
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${sug!.id}/accept`, { headers: hdr, data: {} });
  const afterDoc = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const headings = headingTexts(afterDoc.doc_json);
  // eslint-disable-next-line no-console
  console.log('[restructure] headings after:', JSON.stringify(headings));
  // Every original section survives (nothing dropped).
  for (const sec of ['Photosynthesis', 'Respiration', 'The cell', 'Genetics', 'Ecology']) expect(headings).toContain(sec);
  // Photosynthesis now comes before Respiration and before The cell (the requested order moved it up).
  expect(headings.indexOf('Photosynthesis')).toBeLessThan(headings.indexOf('Respiration'));
  expect(headings.indexOf('Photosynthesis')).toBeLessThan(headings.indexOf('The cell'));

  // UI: open the note and screenshot the reorganised structure.
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Bio restructure', { exact: true }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT}/gw-restructure.png`, fullPage: true });
});

// ── Registration: restructure_note in the catalog + granted to the weaveNotes Editor agent ──
test('AI restructure — restructure_note is a catalogued tool granted to the weavenotes_editor agent', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  expect((tools.tools ?? []).map((t) => t.tool_key)).toContain('restructure_note');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('restructure_note');
});

// ── Agent path: a real chat run drives restructure_note ──
test.describe('agent restructures a note (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('AI restructure — "reorganise my note" → the agent calls restructure_note', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin;
    const hdr = { 'x-csrf-token': await csrf(page) };
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Agent restructure note', doc_json: BIO } })).json() as { id: string };

    const client = await clientFor(page);
    const session = createRunSession({ client });
    const prompt = `Please reorganise and tidy up the structure of my note ${note.id} — group the sections logically and fix the headings.`;
    await session.start({ input: { text: prompt }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    await awaitTerminal(session, 150_000);
    await new Promise((r) => setTimeout(r, 1200));
    session.dispose();

    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    // eslint-disable-next-line no-console
    console.log('[restructure] agent staged actions:', JSON.stringify(pend.suggestions.map((s) => s.action)));
    expect(pend.suggestions.some((s) => s.action === 'restructure_note')).toBe(true);
  });
});
