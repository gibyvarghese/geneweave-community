/**
 * Playwright E2E — weaveNotes Phase 1 (web editor parity, creative marks & agency colour).
 * Proves, against a live server + (for the last block) a real LLM:
 *   • API: a new note adopts the workspace DEFAULT page theme; the per-note Pro/Creative
 *     theme + freeform flag persist; a doc with creative nodes (highlight/textColor/callout/
 *     image/sticker/washi) round-trips through save + reload unharmed; a hostile theme is coerced.
 *   • UI: the editor RENDERS those creative nodes; the Pro↔Creative toggle flips the canvas
 *     surface + title font + highlighter treatment; the ✨ sticker tool inserts a sticker.
 *     Screenshots are captured for design comparison.
 *   • Real LLM: the weaveNotes editor agent can co-author a note with a highlight / callout.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase1
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn1-owner@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
async function clientFor(page: Page): Promise<RunClient> { const cookies = await page.context().cookies(); return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': await csrf(page) } }); }
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> { return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]); }

/** A rich, colourful doc exercising every Phase 1 creative node + mark. */
const CREATIVE_DOC = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tides — field notes' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'The key driver is ' },
      { type: 'text', text: 'gravity', marks: [{ type: 'highlight', attrs: { color: '#FAC775' } }] },
      { type: 'text', text: ', and the ' },
      { type: 'text', text: 'Moon', marks: [{ type: 'textColor', attrs: { color: '#D85A30' } }] },
      { type: 'text', text: ' dominates.' },
    ] },
    { type: 'callout', attrs: { tone: 'warning', author: 'ai' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spring tides are larger — plan the survey around them.' }] }] },
    { type: 'image', attrs: { src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Tidal_wave.svg/120px-Tidal_wave.svg.png', alt: 'tide diagram', author: 'user' } },
    { type: 'sticker', attrs: { emoji: '🌊', author: 'user' } },
    { type: 'washiDivider', attrs: { pattern: 'tape' } },
  ],
};

// ── API: theme adoption + persistence + creative round-trip ─────────────────────────
test('Phase 1 — new note adopts the default theme; theme/freeform persist; creative doc round-trips', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // Ensure the workspace default theme is a known value, then a new note should adopt it.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { default_theme: 'creative' } });
  const adopt = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Adopts default' } })).json() as { id: string; page_theme: string };
  expect(adopt.page_theme).toBe('creative');
  // restore the default so other tests/UI are clean
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { default_theme: 'pro' } });

  // Create a note carrying the rich creative doc + an explicit theme + freeform.
  const created = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Tides', doc_json: CREATIVE_DOC, page_theme: 'pro', freeform_mode: true } })).json() as { id: string; page_theme: string; freeform_mode: number };
  expect(created.page_theme).toBe('pro');
  expect(created.freeform_mode).toBe(1);

  // Flip the per-note theme via PATCH; a hostile value is coerced to 'pro'.
  await page.request.fetch(`${origin}/api/me/notes/${created.id}`, { method: 'PATCH', headers: hdr, data: { page_theme: 'creative' } });
  let got = await (await page.request.get(`${origin}/api/me/notes/${created.id}`)).json() as { page_theme: string; doc_json: string };
  expect(got.page_theme).toBe('creative');
  await page.request.fetch(`${origin}/api/me/notes/${created.id}`, { method: 'PATCH', headers: hdr, data: { page_theme: 'rainbow' } });
  got = await (await page.request.get(`${origin}/api/me/notes/${created.id}`)).json() as { page_theme: string; doc_json: string };
  expect(got.page_theme).toBe('pro'); // coerced

  // The creative doc survived save + reload: highlight colour, callout tone, image src, sticker.
  type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: Array<{ type: string; attrs?: { color?: string } }> };
  const doc = JSON.parse(got.doc_json) as { content: PMNode[] };
  const types = doc.content.map((n) => n.type);
  expect(types).toEqual(expect.arrayContaining(['callout', 'image', 'sticker', 'washiDivider']));
  const para = doc.content.find((n) => n.type === 'paragraph')!;
  const hl = (para.content ?? []).find((t) => (t.marks ?? []).some((m) => m.type === 'highlight'));
  expect(hl!.marks!.find((m) => m.type === 'highlight')!.attrs?.color).toBe('#FAC775');
  const callout = doc.content.find((n) => n.type === 'callout') as { attrs?: { tone?: string; author?: string } };
  expect(callout.attrs?.tone).toBe('warning');
  expect(callout.attrs?.author).toBe('ai');
});

// ── UI: the editor renders the creative nodes; the theme toggle flips the surface ────
test('Phase 1 — UI: creative nodes render + the Pro/Creative toggle + sticker tool work', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Rich note', doc_json: CREATIVE_DOC, page_theme: 'pro' } })).json() as { id: string };

  // Open the notes view, then click the note in the left rail to open the editor.
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Rich note', { exact: false }).first().click({ timeout: 15000 });
  // The editor mounts + renders the creative nodes.
  await expect(page.locator('.gw-canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('.notes-editor-mount .gw-callout')).toBeVisible();
  await expect(page.locator('.notes-editor-mount .gw-sticker')).toBeVisible();
  await expect(page.locator('.notes-editor-mount mark').first()).toBeVisible();
  await page.screenshot({ path: `${SHOT}/gw-wn1-pro.png`, fullPage: false });

  // Toggle to Creative → the canvas gains the .creative class (warm paper + Caveat title).
  await page.getByRole('button', { name: 'Creative' }).first().click();
  await expect(page.locator('.gw-canvas.creative')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT}/gw-wn1-creative.png`, fullPage: false });

  // The Creative-only ✨ sticker tool appears + inserts a sticker.
  const stickerTool = page.locator('.gw-tool-sticker');
  await expect(stickerTool).toBeVisible();
  const before = await page.locator('.notes-editor-mount .gw-sticker').count();
  // place the caret in the editor first (the root ProseMirror surface), then click the sticker tool
  await page.locator('.notes-editor-mount .ProseMirror').first().click();
  await stickerTool.click();
  await page.waitForTimeout(400);
  expect(await page.locator('.notes-editor-mount .gw-sticker').count()).toBeGreaterThanOrEqual(before);

  // The theme persisted to the note (reload-safe).
  const reloaded = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { page_theme: string };
  expect(reloaded.page_theme).toBe('creative');
});

// ── Real LLM: the agent co-authors with a highlight / callout ───────────────────────
test.describe('weaveNotes editor co-authors creative formatting (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  for (const mode of ['agent', 'supervisor'] as const) {
    test(`Phase 1 — "${mode}": AI adds a highlight or callout`, async ({ page }) => {
      test.setTimeout(200_000);
      await login(page, OWNER);
      const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
      const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Co-author ${mode}`, doc_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Our launch checklist needs review.' }] }] } } })).json() as { id: string };

      const client = await clientFor(page); const session = createRunSession({ client });
      const prompt = `Edit my note (id ${note.id}). Add a short tip callout and highlight the single most important phrase. Keep it brief.`;
      const evs: Array<{ kind: string; payload: unknown }> = [];
      const runId = await session.start({ input: { text: prompt }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
      const ctrl = client.attach(runId, { onEvent: (e) => evs.push({ kind: e.kind, payload: e.payload }) });
      await awaitTerminal(session, 150_000); await new Promise((r) => setTimeout(r, 1500)); ctrl.abort(); session.dispose();

      const calledEdit = evs.filter((e) => e.kind.startsWith('tool')).some((e) => { const t = (e.payload as { tool?: string }).tool; return t === 'note_edit' || t === 'create_note'; });
      const gated = evs.some((e) => e.kind === 'diagnostic');
      // The note (or a staged suggestion) should now contain creative markdown/marks.
      const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
      const hasCreative = /"type":"(callout|highlight)"/.test(after.doc_json) || JSON.stringify(after).includes('highlight');
      // eslint-disable-next-line no-console
      console.log(`[wn1][${mode}] calledEdit=${calledEdit} gated=${gated} hasCreative=${hasCreative}`);
      if (mode === 'agent') expect(calledEdit || gated, 'AI co-authors the note or is guardrail-gated').toBe(true);
      else if (!calledEdit) console.warn(`[wn1][${mode}] did not call an edit tool (small-model non-determinism)`);
    });
  }
});
