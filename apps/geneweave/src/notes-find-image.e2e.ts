/**
 * weaveNotes — find_image: source a REAL, free-to-use image from the web (hardened fetch + attribution).
 *
 *   • POST /api/me/notes/:id/ai/find-image { query } → searches a free-image provider through the
 *     HARDENED (SSRF-guarded) fetch, downloads the chosen image (also hardened), stores it as an
 *     artifact, and stages an image block with a licence + attribution caption.
 *   • Registration: find_image is a catalogued tool granted to the weaveNotes Editor agent.
 *   • Config: disabling web image search refuses the action.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-find-image
 */
import { test, expect, type Page } from '@playwright/test';
const PW = 'Str0ng!Pass99', E = 'findimage@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';
const HEART = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Human Heart' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'A muscular organ with four chambers that pumps blood around the body.' }] },
] });
async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'fi', email: E, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: E, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}
function imageNode(docJson: string): { src?: string; caption?: string; license?: string; alt?: string } | null {
  const doc = JSON.parse(docJson) as { content?: Array<{ type: string; attrs?: any }> };
  return (doc.content ?? []).find((n) => n.type === 'image')?.attrs ?? null;
}

test('find_image — sources a real free-to-use heart image with attribution (hardened fetch)', async ({ page }) => {
  test.setTimeout(120_000);
  const { origin, H } = await login(page);
  await page.setViewportSize({ width: 1000, height: 1100 });
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Heart photo', doc_json: HEART, page_theme: 'creative' } })).json() as { id: string };

  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/find-image`, { headers: H, data: { query: 'human heart anatomy diagram' } });
  const body = await r.json() as { ok: boolean; via?: string; suggestionId?: string; preview?: string };
  // eslint-disable-next-line no-console
  console.log('[find-image] response:', JSON.stringify(body));
  expect(r.status()).toBe(201);
  expect(body.ok).toBe(true);
  expect(body.via).toBe('direct'); // default routing for find_image

  // Pending suggestion carries a licence/attribution preview.
  const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string; preview: string }> };
  const sug = pend.suggestions.find((s) => s.action === 'find_image');
  expect(sug).toBeTruthy();
  expect(sug!.preview).toMatch(/Image:.*(via )/);

  // Accept → the note has a real image block (artifact-backed) with an attribution caption + licence.
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${sug!.id}/accept`, { headers: H, data: {} });
  const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const img = imageNode(after.doc_json);
  // eslint-disable-next-line no-console
  console.log('[find-image] image node:', JSON.stringify(img));
  expect(img?.src).toMatch(/^\/api\/artifacts\/[\w-]+\/data$/);
  expect(img?.caption).toBeTruthy();
  expect(img?.caption).toMatch(/via (Openverse|Wikimedia Commons|Unsplash|Pexels|Pixabay)/);
  expect(img?.license).toBeTruthy();

  // The artifact really is an image (the hardened fetch validated content-type).
  const artRes = await page.request.get(`${origin}${img!.src}`);
  expect(artRes.status()).toBe(200);
  expect((artRes.headers()['content-type'] ?? '')).toMatch(/^image\//);

  // UI: open + screenshot (a REAL heart image with a credit line).
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Heart photo', { exact: true }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/heart-find-image.png`, fullPage: true });
});

test('find_image — a LONG selected passage is summarised into a focused query (not searched raw)', async ({ page }) => {
  test.setTimeout(120_000);
  const { origin, H } = await login(page);
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Long sel', doc_json: HEART } })).json() as { id: string };
  // Simulate selecting a big paragraph (what the selection card would send as the query).
  const longSelection = 'The human heart is a hollow, muscular organ roughly the size of a clenched fist, located slightly left of the centre of the chest between the lungs. It is divided into four chambers — the right and left atria above and the right and left ventricles below — separated by valves that keep blood moving in one direction. Deoxygenated blood returns from the body through the venae cavae into the right atrium, passes to the right ventricle, and is pumped to the lungs via the pulmonary artery, while oxygenated blood returns to the left atrium and is pumped out to the body through the aorta.';
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/find-image`, { headers: H, data: { query: longSelection } });
  const body = await r.json() as { ok: boolean };
  expect(body.ok).toBe(true);
  const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  // Find the staged image (accept first).
  const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string }> };
  const sug = pend.suggestions.find((s) => s.action === 'find_image');
  expect(sug).toBeTruthy();
  await page.request.post(`${origin}/api/me/notes/${note.id}/suggestions/${sug!.id}/accept`, { headers: H, data: {} });
  const doc = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const img = imageNode(doc.doc_json);
  // The alt is the DERIVED query — short, focused, NOT the raw 500+ char paragraph.
  // eslint-disable-next-line no-console
  console.log('[find-image] derived alt for long selection:', JSON.stringify(img?.alt));
  expect((img?.alt ?? '').length).toBeLessThan(80);
  expect((img?.alt ?? '').length).toBeLessThan(longSelection.length / 4);
  expect(img?.src).toMatch(/^\/api\/artifacts\//);
  void after;
});

test('find_image — per-user image language defaults to English and is configurable (DB-backed)', async ({ page }) => {
  test.setTimeout(120_000);
  const { origin, H } = await login(page);
  // Default is English.
  const g0 = await (await page.request.get(`${origin}/api/me/notes-image-language`)).json() as { language: string; languages: Record<string, string> };
  expect(g0.language).toBe('en');
  expect(g0.languages['fr']).toBe('French');
  // Set + read back (normalised from a name/locale).
  await page.request.put(`${origin}/api/me/notes-image-language`, { headers: H, data: { language: 'French' } });
  expect(((await (await page.request.get(`${origin}/api/me/notes-image-language`)).json()) as { language: string }).language).toBe('fr');
  await page.request.put(`${origin}/api/me/notes-image-language`, { headers: H, data: { language: 'en-GB' } });
  expect(((await (await page.request.get(`${origin}/api/me/notes-image-language`)).json()) as { language: string }).language).toBe('en');
  // find_image still works with the preference set (default en restored above).
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Lang note', doc_json: HEART } })).json() as { id: string };
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/find-image`, { headers: H, data: { query: 'human heart' } });
  expect((await r.json() as { ok: boolean }).ok).toBe(true);
});

test('find_image — catalogued tool granted to the weavenotes_editor agent', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin } = await login(page);
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  expect((tools.tools ?? []).map((t) => t.tool_key)).toContain('find_image');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('find_image');
});

test('find_image — disabling web image search refuses the action', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  // Disable via the weaveNotes settings admin.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: H, data: { image_search_enabled: false } });
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'No image', doc_json: HEART } })).json() as { id: string };
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/find-image`, { headers: H, data: { query: 'cat' } });
  const body = await r.json() as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error ?? '').toMatch(/disabled/i);
  // Re-enable so other tests on the shared server are unaffected.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: H, data: { image_search_enabled: true } });
});
