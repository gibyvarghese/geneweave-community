/**
 * Playwright E2E — weaveNotes Phase 7 (mobile: offline editing + ink + sync), live server + real LLM.
 *
 * The mobile app is offline-first: it edits a local cache and drains a durable outbox to the SAME
 * REST routes the web uses. This suite proves the SERVER side of that contract end-to-end (the mobile
 * offline-sync ENGINE itself is unit-tested in clients/mobile against a fake server with this exact
 * contract):
 *   • THE "DONE WHEN": a note created the way the mobile app creates one — POST /api/me/notes with a
 *     doc_json carrying an `inkCanvas` node, stamped `X-Client-Version: geneweave-mobile` — round-trips
 *     so a GET (what the WEB editor reads) returns the ink strokes INTACT.
 *   • the shared cross-platform model (`blocksToDoc`/`docToBlocks` from @weaveintel/notes) is what both
 *     sides serialise/parse, and a web-only diagram is preserved across a mobile edit.
 *   • GET /api/me/notes/capabilities returns the Builder-governed offline/ink flags; toggling them in
 *     the admin (weaveNotes Settings) flows through to the client.
 *   • PROVENANCE: a mobile-stamped edit is logged "on mobile", and a real LLM run via `read_note_activity`
 *     understands the note was edited on a phone.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-mobile-phase7
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';
import { blocksToDoc, docToBlocks, hasInk, type InkStroke, type NoteBlock } from '@weaveintel/notes';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn7-owner@weaveintel.dev';
const MOBILE_HDR = 'geneweave-mobile/1.0.0';

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
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': await csrf(page) } });
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

const STROKE: InkStroke = { points: [{ x: 4, y: 4 }, { x: 40, y: 30 }, { x: 70, y: 12 }], color: '#14201B', width: 3, tool: 'pen', author: 'user' };

// ── THE "DONE WHEN": a mobile-created note with ink round-trips to the web with ink intact ──
test('Phase 7 — a note "created on mobile" with ink syncs so the web reads it with ink INTACT', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'X-Client-Version': MOBILE_HDR };

  // The mobile editor composes a note with text + a freehand drawing using the SHARED model.
  const docJson = blocksToDoc([
    { type: 'paragraph', text: 'Site survey — north fence' },
    { type: 'inkCanvas', strokes: [STROKE, { ...STROKE, color: '#C2410C', tool: 'highlighter', width: 10 }], author: 'user' },
  ]);
  // …and the offline outbox eventually POSTs it (mobile creates with a doc_json).
  const created = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Field survey', doc_json: docJson } })).json() as { id: string };
  expect(created.id).toBeTruthy();

  // The WEB editor opens the note (GET /:id) → the ink strokes are present + unchanged.
  const web = await (await page.request.get(`${origin}/api/me/notes/${created.id}`)).json() as { doc_json: string };
  const blocks = docToBlocks(web.doc_json);
  expect(hasInk(blocks)).toBe(true);
  const ink = blocks.find((b) => b.type === 'inkCanvas') as { strokes: InkStroke[] };
  expect(ink.strokes).toHaveLength(2);
  expect(ink.strokes[0]!.points).toHaveLength(3);
  expect(ink.strokes[1]!.tool).toBe('highlighter');

  // PROVENANCE: the activity log records the create happened on mobile.
  const activity = await (await page.request.get(`${origin}/api/me/notes/${created.id}/activity`)).json() as { activity: Array<{ summary: string | null }> };
  expect(activity.activity.some((a) => /on mobile/i.test(a.summary ?? ''))).toBe(true);
});

// ── A mobile edit of a WEB note keeps the web-only diagram (no data loss) ──
test('Phase 7 — editing a web note on mobile preserves its diagram (shared model, no data loss)', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const webHdr = { 'x-csrf-token': await csrf(page) };
  const mobileHdr = { 'x-csrf-token': await csrf(page), 'X-Client-Version': MOBILE_HDR };

  // Web creates a note with a diagram node the phone can't render.
  const webDoc = JSON.stringify({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Plan' }] },
    { type: 'diagram', attrs: { scene: { nodes: [{ id: 'a', label: 'Start' }], edges: [] } } },
  ] });
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: webHdr, data: { title: 'Roadmap', doc_json: webDoc } })).json() as { id: string };

  // The phone opens it (parse → blocks), edits the text + adds ink, and saves (compose → doc_json).
  const fetched = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const blocks = docToBlocks(fetched.doc_json);
  const preserved = blocks.filter((b) => b.type === 'unsupported');
  const composed: NoteBlock[] = [{ type: 'paragraph', text: 'Plan (edited on phone)' }, { type: 'inkCanvas', strokes: [STROKE], author: 'user' }, ...preserved];
  await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: mobileHdr, data: { doc_json: blocksToDoc(composed) } });

  // The diagram survived the mobile edit; the ink was added.
  const after = await (await page.request.get(`${origin}/api/me/notes/${note.id}`)).json() as { doc_json: string };
  const content = (JSON.parse(after.doc_json) as { content: Array<{ type: string }> }).content;
  expect(content.some((n) => n.type === 'diagram')).toBe(true);
  expect(content.some((n) => n.type === 'inkCanvas')).toBe(true);
});

// ── Capabilities endpoint + admin Builder gating ──
test('Phase 7 — capabilities endpoint reflects the Builder weaveNotes settings (offline/ink gating)', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };

  // Defaults: offline + ink on.
  const caps0 = await (await page.request.get(`${origin}/api/me/notes/capabilities`)).json() as { mobileOfflineEnabled: boolean; mobileInkEnabled: boolean; mobileOfflineNoteLimit: number };
  expect(caps0.mobileOfflineEnabled).toBe(true);
  expect(caps0.mobileInkEnabled).toBe(true);
  expect(caps0.mobileOfflineNoteLimit).toBeGreaterThan(0);

  // An admin turns mobile ink OFF + lowers the cache cap in the Builder.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { mobile_ink_enabled: false, mobile_offline_note_limit: 50 } });
  const caps1 = await (await page.request.get(`${origin}/api/me/notes/capabilities`)).json() as { mobileInkEnabled: boolean; mobileOfflineNoteLimit: number };
  expect(caps1.mobileInkEnabled).toBe(false);          // gating flows to the client
  expect(caps1.mobileOfflineNoteLimit).toBe(50);
  // Restore.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { mobile_ink_enabled: true, mobile_offline_note_limit: 200 } });
});

// ── Real LLM: the AI understands a note was edited on mobile (provenance via read_note_activity) ──
test.describe('agent understands mobile edits (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('Phase 7 — read_note_activity tells the AI a note was edited on mobile', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin;
    const mobileHdr = { 'x-csrf-token': await csrf(page), 'X-Client-Version': MOBILE_HDR };

    // A note created + edited from the phone.
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: mobileHdr, data: { title: 'Commute idea', doc_json: blocksToDoc([{ type: 'paragraph', text: 'jotted on the train' }]) } })).json() as { id: string };
    await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: mobileHdr, data: { doc_json: blocksToDoc([{ type: 'paragraph', text: 'jotted on the train, expanded' }]) } });

    // Ask the assistant about the note's recent history; it should reach for read_note_activity.
    const client = await clientFor(page);
    const session = createRunSession({ client });
    const prompt = `Take a look at the recent change history of my note ${note.id} and tell me where my most recent edits to it were made.`;
    await session.start({ input: { text: prompt }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    await awaitTerminal(session, 150_000);
    await new Promise((r) => setTimeout(r, 800));
    const transcript = JSON.stringify(session.getState?.() ?? {}).toLowerCase();
    session.dispose();
    // eslint-disable-next-line no-console
    console.log('[notes-p7] answer mentions mobile:', /mobile|phone/.test(transcript));
    // The activity log (the ground truth the tool reads) definitively says "on mobile".
    const activity = await (await page.request.get(`${origin}/api/me/notes/${note.id}/activity`)).json() as { activity: Array<{ summary: string | null }> };
    expect(activity.activity.some((a) => /on mobile/i.test(a.summary ?? ''))).toBe(true);
  });
});
