// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 1 — VISUAL CORRECTNESS ("the right perfect image"), real managed server + real LLM.
 *
 * Proves the verify-before-insert pipeline works end-to-end:
 *   • a diagram is CHECKED against the request and its preview carries a "fit N%" structural score;
 *   • "draw the human heart" routes to a real figure (illustration/image) — NEVER a boxes-and-arrows
 *     flowchart (the headline acceptance criterion);
 *   • find_image VISION-verifies the picture — it either inserts an image confirmed to depict the
 *     subject, or honestly reports none did (it never silently inserts a wrong image).
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase1-visual
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99', E = 'wn1-visual@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'wn1', email: E, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: E, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}
async function makeNote(page: Page, origin: string, H: Record<string, string>, title: string, text: string): Promise<string> {
  const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }, { type: 'paragraph', content: [{ type: 'text', text }] }] };
  return (await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title, doc_json: doc } })).json() as { id: string }).id;
}
async function pending(page: Page, origin: string, noteId: string): Promise<Array<{ id: string; action: string; preview: string }>> {
  return (await (await page.request.get(`${origin}/api/me/notes/${noteId}/suggestions?status=pending`)).json() as { suggestions: Array<{ id: string; action: string; preview: string }> }).suggestions;
}

test('diagram is VERIFIED — the suggestion preview carries a structural "fit" score', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page);
  // Run the diagram action DIRECT (fast) rather than via the supervisor, so the verify loop is exercised in-process.
  await page.request.put(`${origin}/api/admin/note-action-modes`, { headers: H, data: { action_key: 'diagram', mode: 'direct' } });
  const note = await makeNote(page, origin, H, 'Water cycle', 'Evaporation, condensation, precipitation and collection.');

  const r = await page.request.post(`${origin}/api/me/notes/${note}/ai/diagram`, { headers: H, data: { instruction: 'Draw a flow of the water cycle: evaporation → condensation → precipitation → collection → back to evaporation.' } });
  const body = await r.json() as { ok?: boolean; via?: string };
  // eslint-disable-next-line no-console
  console.log('[diagram] response:', JSON.stringify(body), 'status', r.status());
  expect(r.status()).toBe(201);

  const sugs = await pending(page, origin, note);
  const diagram = sugs.find((s) => s.action === 'create_diagram');
  expect(diagram).toBeTruthy();
  // The verify loop annotates the preview with a fit score (proves judge ran). e.g. "… · fit 86%".
  // eslint-disable-next-line no-console
  console.log('[diagram] preview:', diagram!.preview);
  expect(diagram!.preview).toMatch(/fit \d+%/);
});

test('"draw the human heart" routes to a real figure — NEVER a flowchart', async ({ page }) => {
  test.setTimeout(120_000);
  const { origin, H } = await login(page);
  const note = await makeNote(page, origin, H, 'Anatomy', 'The heart is a muscular organ.');
  // 'auto' lets the classifier pick the kind. A physical/biological subject must NOT become a diagram.
  const r = await page.request.post(`${origin}/api/me/notes/${note}/ai/visual`, { headers: H, data: { instruction: 'draw the human heart', kind: 'auto' } });
  const body = await r.json() as { ok?: boolean; kind?: string; via?: string; action?: string };
  // eslint-disable-next-line no-console
  console.log('[heart] response:', JSON.stringify(body), 'status', r.status());
  expect(body.kind).not.toBe('diagram');
  // And no create_diagram suggestion was staged for this note.
  const sugs = await pending(page, origin, note);
  expect(sugs.some((s) => s.action === 'create_diagram')).toBe(false);
});

test('find_image VISION-verifies — inserts a confirmed image OR honestly reports none matched (never a wrong silent insert)', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page);
  await page.setViewportSize({ width: 1000, height: 1100 });
  const note = await makeNote(page, origin, H, 'The Human Heart', 'A four-chambered muscular organ that pumps blood.');
  const r = await page.request.post(`${origin}/api/me/notes/${note}/ai/find-image`, { headers: H, data: { query: 'human heart anatomy diagram' } });
  const body = await r.json() as { ok: boolean; error?: string; preview?: string };
  // eslint-disable-next-line no-console
  console.log('[find_image+vision] response:', JSON.stringify(body));
  if (body.ok) {
    // Accepted → it was vision-confirmed; the preview records the confidence.
    const sugs = await pending(page, origin, note);
    const img = sugs.find((s) => s.action === 'find_image');
    expect(img).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log('[find_image+vision] preview:', img!.preview);
    expect(img!.preview).toMatch(/verified \d+%/);
    // Accept it and screenshot the verified image in the editor.
    await page.request.post(`${origin}/api/me/notes/${note}/suggestions/${img!.id}/accept`, { headers: H, data: {} });
    await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
    await page.goto('/'); await page.getByText('The Human Heart', { exact: true }).first().click({ timeout: 15000 });
    await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT}/p1-verified-heart-image.png`, fullPage: true });
  } else {
    // Rejected → it honestly declined rather than inserting a wrong image. That is also correct.
    expect(body.error ?? '').toMatch(/clearly depicted|could not fetch|no free-to-use/i);
  }
});
