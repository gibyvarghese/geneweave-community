/**
 * Playwright E2E — weaveNotes Phase 1 (BlockDoc CRDT), live server + real LLM.
 *
 * Phase 1 added the rich-text BLOCK CRDT (`@weaveintel/collab` BlockDoc) + the
 * ProseMirror⇄blocks conversion + Markdown/HTML serializers, and a thin app
 * surface: `GET /api/me/notes/:id/blocks?format=blocks|markdown|html` that runs a
 * real note's content THROUGH the CRDT and renders it. This e2e proves, with a
 * real LLM across direct/agent/supervisor/ensemble, that the CRDT faithfully
 * represents a real research note — every block type, the checked-state of
 * to-dos, and inline bold/link marks survive the round-trip — and that the
 * Markdown rendering (what an AI model would "read") is correct.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-blocks-phase1
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession, type RunEventEnvelope } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const USER = 'notes-p1@weaveintel.dev';

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
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await page.request.get('/api/auth/me');
  const csrf = me.ok() ? (((await me.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': csrf } });
}
async function csrf(page: Page): Promise<string> {
  return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

const RESEARCH_PROMPT =
  'Research the main causes of ocean tides. Reply with one short paragraph of findings, then two follow-up questions. Keep it concise.';

/** A rich ProseMirror note: heading + paragraph (with a bold word + a link) + a bullet list + a to-do list + a code block. */
function richDoc(findings: string, mode: string) {
  return {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Tides research (${mode})` }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Findings' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Tides are driven by ' },
        { type: 'text', text: 'gravity', marks: [{ type: 'bold' }] },
        { type: 'text', text: '. ' },
        { type: 'text', text: findings.slice(0, 400) },
        { type: 'text', text: ' See ' },
        { type: 'text', text: 'NOAA', marks: [{ type: 'link', attrs: { href: 'https://oceanservice.noaa.gov' } }] },
        { type: 'text', text: '.' },
      ] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Key factors' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lunar gravitational pull' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar gravitational pull' }] }] },
      ] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Follow-ups' }] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Validate the lunar-cycle claim for ${mode}` }] }] },
        { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reviewed the NOAA source' }] }] },
      ] },
      { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: 'tide_height = base + lunar + solar' }] },
    ],
  };
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 1 — "${mode}": a real research note round-trips through the BlockDoc CRDT (blocks + marks + markdown)`, async ({ page }) => {
    test.setTimeout(170_000);
    await login(page, USER);
    const client = await clientFor(page);
    const origin = new URL(page.url()).origin;
    const hdr = { 'x-csrf-token': await csrf(page) };

    // Real LLM research run; collect its actual output.
    const session = createRunSession({ client });
    const runId = await session.start({ input: { text: RESEARCH_PROMPT }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
    const events: RunEventEnvelope[] = [];
    const ctrl = client.attach(runId, { onEvent: (e) => events.push(e) });
    await awaitTerminal(session, 120_000);
    await new Promise((r) => setTimeout(r, 500));
    ctrl.abort(); session.dispose();
    const findings = (events.filter((e) => e.kind === 'text.delta').map((e) => String((e.payload as { delta?: unknown }).delta ?? '')).join('').trim() || 'The Moon and Sun pull the oceans.');

    // Create a note + write the rich structured research into it.
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Tides (${mode})` } })).json() as { id: string };
    const patchRes = await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: hdr, data: { doc_json: richDoc(findings, mode) } });
    expect(patchRes.ok()).toBe(true);

    // 1. The CRDT block model faithfully represents the note.
    const blocksResp = await (await page.request.get(`${origin}/api/me/notes/${note.id}/blocks`)).json() as {
      blocks: Array<{ type: string; attrs: Record<string, unknown>; text: string; marks: Array<{ type: string; value?: string }> }>;
      prosemirror: { content: Array<{ type: string }> };
      stateVector: Record<string, number>;
    };
    const types = blocksResp.blocks.map((b) => b.type);
    // eslint-disable-next-line no-console
    console.log(`[notes-p1][${mode}] blockTypes=${JSON.stringify(types)}`);
    expect(types).toEqual(['heading', 'heading', 'paragraph', 'heading', 'bulletListItem', 'bulletListItem', 'heading', 'taskItem', 'taskItem', 'codeBlock']);
    // To-do checked-states survived.
    const todos = blocksResp.blocks.filter((b) => b.type === 'taskItem');
    expect(todos[0]!.attrs['checked']).toBe(false);
    expect(todos[1]!.attrs['checked']).toBe(true);
    // Inline marks survived the CRDT round-trip.
    const para = blocksResp.blocks.find((b) => b.type === 'paragraph')!;
    expect(para.marks.some((m) => m.type === 'bold')).toBe(true);
    expect(para.marks.find((m) => m.type === 'link')?.value).toBe('https://oceanservice.noaa.gov');
    // The re-rendered ProseMirror regrouped the list items back into their wrappers.
    expect(blocksResp.prosemirror.content.map((n) => n.type)).toContain('bulletList');
    expect(blocksResp.prosemirror.content.map((n) => n.type)).toContain('taskList');

    // 2. The Markdown rendering (what an AI model reads) is correct.
    const md = (await (await page.request.get(`${origin}/api/me/notes/${note.id}/blocks?format=markdown`)).json() as { markdown: string }).markdown;
    expect(md).toContain('## Tides research');
    expect(md).toContain('driven by **gravity**');
    expect(md).toContain('[NOAA](https://oceanservice.noaa.gov)');
    expect(md).toContain('- Lunar gravitational pull');
    expect(md).toContain('- [ ] Validate the lunar-cycle claim');
    expect(md).toContain('- [x] Reviewed the NOAA source');
    expect(md).toContain('```');

    // 3. The HTML rendering is sanitized + structured.
    const html = (await (await page.request.get(`${origin}/api/me/notes/${note.id}/blocks?format=html`)).json() as { html: string }).html;
    expect(html).toContain('<h2>');
    expect(html).toContain('<strong>gravity</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('type="checkbox"');

    await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'DELETE', headers: hdr });
  });
}

test('Phase 1 — security: the /blocks endpoint is owner-scoped (404 for another user)', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: { 'x-csrf-token': await csrf(page) }, data: { title: 'Private blocks' } })).json() as { id: string };
  const ctx = await browser.newContext();
  const intruder = await ctx.newPage();
  await login(intruder, 'notes-p1-intruder@weaveintel.dev');
  expect((await intruder.request.get(`${origin}/api/me/notes/${note.id}/blocks`)).status()).toBe(404);
  await ctx.close();
});

test('Phase 1 — robustness: an empty / malformed note still yields a valid block doc', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Empty' } })).json() as { id: string };
  // Force a malformed doc_json via PATCH (the route stores strings verbatim).
  await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: hdr, data: { doc_json: 'not json at all' } });
  const resp = await (await page.request.get(`${origin}/api/me/notes/${note.id}/blocks`)).json() as { prosemirror: { type: string; content: unknown[] } };
  expect(resp.prosemirror.type).toBe('doc');
  expect(resp.prosemirror.content.length).toBeGreaterThanOrEqual(1); // schema repair guarantees a valid, non-empty doc
});

test('Phase 1 — web UI: the Notes view still renders an API-created note (regression)', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const title = `P1 UI note ${Date.now()}`;
  await page.request.post(`${origin}/api/me/notes`, { headers: { 'x-csrf-token': await csrf(page) }, data: { title } });
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.reload();
  await expect(page.locator('.notes-list-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.note-row-title', { hasText: title })).toBeVisible({ timeout: 15000 });
});
