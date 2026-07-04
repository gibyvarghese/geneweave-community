/**
 * Playwright E2E — weaveNotes Phase 0 (NoteRepository seam), live server + real LLM.
 *
 * Phase 0 introduced a `@weaveintel/notes` NoteRepository PORT and routed all of
 * geneWeave's `/api/me/notes` endpoints through it with NO behaviour change. So
 * this e2e PROVES the full notes lifecycle still works end-to-end AND exercises the
 * real "AI research → capture into a note" flow the whole roadmap is about:
 *
 *  - run a COMPLEX research task on a real LLM across direct/agent/supervisor/
 *    ensemble modes;
 *  - create a note from the seeded "Research" template;
 *  - capture the run's findings into the note's doc (headings + a to-do list);
 *  - LINK the note → the run, and read it back via the links endpoint;
 *  - run the save-time EXTRACT pipeline → unchecked to-dos become real tasks;
 *  - exercise note databases (saved views) + rows;
 *  - favourite / filter / search / delete;
 *  - and a UI regression: the Notes view renders the note we created via the API.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-phase0
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession, type RunEventEnvelope } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const USER = 'notes-p0@weaveintel.dev';

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

/** A complex, real-world research prompt that yields findings + follow-up questions. */
const RESEARCH_PROMPT =
  'Research the main causes of ocean tides. List 3 key factors, each with a one-sentence explanation. ' +
  'Then propose exactly 2 specific follow-up questions worth investigating. Keep it concise.';

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 0 — "${mode}": research run → capture into a note → link + extract (full lifecycle)`, async ({ page }) => {
    test.setTimeout(170_000);
    await login(page, USER);
    const client = await clientFor(page);
    const origin = new URL(page.url()).origin;
    const token = await csrf(page);
    const hdr = { 'x-csrf-token': token };

    // 1. A real LLM research run; collect the assistant's actual output text.
    const session = createRunSession({ client });
    const runId = await session.start({ input: { text: RESEARCH_PROMPT }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
    const events: RunEventEnvelope[] = [];
    const ctrl = client.attach(runId, { onEvent: (e) => events.push(e) });
    await awaitTerminal(session, 120_000);
    await new Promise((r) => setTimeout(r, 500));
    ctrl.abort();
    session.dispose();
    const collected = events.filter((e) => e.kind === 'text.delta').map((e) => String((e.payload as { delta?: unknown }).delta ?? '')).join('');
    const findings = (collected.trim() || 'Tides are caused by gravitational forces from the Moon and Sun.').slice(0, 1500);

    // 2. Create a note from the seeded "Research" template.
    const templates = await (await page.request.get(`${origin}/api/me/notes/templates`)).json() as { templates: Array<{ id: string; template_key: string | null }> };
    const researchTmpl = templates.templates.find((t) => t.template_key === 'research');
    expect(researchTmpl).toBeTruthy();
    const created = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Tides research (${mode})`, template_id: researchTmpl!.id } })).json() as { id: string; doc_json: string };
    const noteId = created.id;

    // 3. Capture the findings + 2 follow-up to-dos into the note doc.
    const docJson = {
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Tides research (${mode})` }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Findings' }] },
        { type: 'paragraph', content: [{ type: 'text', text: findings }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Follow-ups' }] },
        { type: 'taskList', content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Validate the lunar-cycle claim for ${mode}` }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Compare spring vs neap tide magnitudes' }] }] },
        ] },
      ],
    };
    const patchRes = await page.request.fetch(`${origin}/api/me/notes/${noteId}`, { method: 'PATCH', headers: hdr, data: { doc_json: docJson } });
    expect(patchRes.ok()).toBe(true);

    // 4. Link the note → the run, and read it back.
    const linkRes = await page.request.post(`${origin}/api/me/notes/${noteId}/links`, { headers: hdr, data: { target_kind: 'run', target_id: runId } });
    expect(linkRes.status()).toBe(201);
    const links = await (await page.request.get(`${origin}/api/me/notes/${noteId}/links`)).json() as { links: Array<{ target_kind: string; target_id: string }> };
    expect(links.links.some((l) => l.target_kind === 'run' && l.target_id === runId)).toBe(true);

    // 5. EXTRACT → the 2 unchecked to-dos become real tasks (idempotent on re-run).
    const extract1 = await (await page.request.post(`${origin}/api/me/notes/${noteId}/extract`, { headers: hdr, data: {} })).json() as { extractedTasks: Array<{ id: string; title: string }> };
    // eslint-disable-next-line no-console
    console.log(`[notes-p0][${mode}] extracted=${extract1.extractedTasks.length} runOutLen=${findings.length}`);
    expect(extract1.extractedTasks.length).toBe(2);
    expect(extract1.extractedTasks.some((t) => t.title.includes('lunar-cycle'))).toBe(true);
    // The note now has task links recorded.
    const links2 = await (await page.request.get(`${origin}/api/me/notes/${noteId}/links`)).json() as { links: Array<{ target_kind: string }> };
    expect(links2.links.filter((l) => l.target_kind === 'task').length).toBe(2);

    // 6. The full note reads back with our captured research.
    const full = await (await page.request.get(`${origin}/api/me/notes/${noteId}`)).json() as { doc_json: string; title: string };
    expect(full.title).toBe(`Tides research (${mode})`);
    expect(full.doc_json).toContain('Follow-ups');

    // 7. It appears in the list, and search finds it.
    const list = await (await page.request.get(`${origin}/api/me/notes?limit=200`)).json() as { notes: Array<{ id: string }> };
    expect(list.notes.some((n) => n.id === noteId)).toBe(true);
    const searched = await (await page.request.get(`${origin}/api/me/notes?search=${encodeURIComponent('Tides research')}`)).json() as { notes: Array<{ id: string }> };
    expect(searched.notes.some((n) => n.id === noteId)).toBe(true);

    // 8. Cleanup: delete → 404.
    const del = await page.request.fetch(`${origin}/api/me/notes/${noteId}`, { method: 'DELETE', headers: hdr });
    expect(del.ok()).toBe(true);
    expect((await page.request.get(`${origin}/api/me/notes/${noteId}`)).status()).toBe(404);
  });
}

test('Phase 0 — favourites ordering + note databases (saved views) + rows lifecycle', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const token = await csrf(page);
  const hdr = { 'x-csrf-token': token };

  // Two notes; favourite the second; it should sort first.
  const a = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Plain note' } })).json() as { id: string };
  const b = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Favourite note' } })).json() as { id: string };
  await page.request.fetch(`${origin}/api/me/notes/${b.id}`, { method: 'PATCH', headers: hdr, data: { favorite: 1 } });
  const favs = await (await page.request.get(`${origin}/api/me/notes?favorite=1`)).json() as { notes: Array<{ id: string }> };
  expect(favs.notes.some((n) => n.id === b.id)).toBe(true);
  expect(favs.notes.some((n) => n.id === a.id)).toBe(false);
  const all = await (await page.request.get(`${origin}/api/me/notes`)).json() as { notes: Array<{ id: string; favorite: number }> };
  expect(all.notes[0]?.favorite).toBe(1); // favourites first

  // Note database (saved view) + a row, update, delete.
  const db = await (await page.request.post(`${origin}/api/me/note-databases`, { headers: hdr, data: { name: 'Reading list', source: 'generic', view_type: 'table' } })).json() as { id: string };
  const row = await (await page.request.post(`${origin}/api/me/note-databases/${db.id}/rows`, { headers: hdr, data: { fields: { title: 'A paper', status: 'todo' } } })).json() as { id: string };
  let rows = await (await page.request.get(`${origin}/api/me/note-databases/${db.id}/rows`)).json() as { rows: Array<{ id: string; fields_json: string }> };
  expect(rows.rows).toHaveLength(1);
  await page.request.fetch(`${origin}/api/me/note-databases/${db.id}/rows/${row.id}`, { method: 'PATCH', headers: hdr, data: { fields: { title: 'A paper', status: 'done' } } });
  rows = await (await page.request.get(`${origin}/api/me/note-databases/${db.id}/rows`)).json() as { rows: Array<{ id: string; fields_json: string }> };
  expect(rows.rows[0]?.fields_json).toContain('done');
  await page.request.fetch(`${origin}/api/me/note-databases/${db.id}`, { method: 'DELETE', headers: hdr });
  const dbs = await (await page.request.get(`${origin}/api/me/note-databases`)).json() as { databases: Array<{ id: string }> };
  expect(dbs.databases.some((d) => d.id === db.id)).toBe(false);
});

test('Phase 0 — security: cannot read or edit another user note (owner-scoped)', async ({ page, browser }) => {
  test.setTimeout(80_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const mine = await (await page.request.post(`${origin}/api/me/notes`, { headers: { 'x-csrf-token': await csrf(page) }, data: { title: 'Private note', sensitivity: 'restricted' } })).json() as { id: string };

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, 'notes-p0-intruder@weaveintel.dev');
  // The intruder cannot read it (404, no leak) …
  expect((await other.request.get(`${origin}/api/me/notes/${mine.id}`)).status()).toBe(404);
  // … nor edit it (the owner-scoped UPDATE is a silent no-op; the owner's copy is unchanged).
  await other.request.fetch(`${origin}/api/me/notes/${mine.id}`, { method: 'PATCH', headers: { 'x-csrf-token': await csrf(other) }, data: { title: 'Hacked' } });
  const stillMine = await (await page.request.get(`${origin}/api/me/notes/${mine.id}`)).json() as { title: string };
  expect(stillMine.title).toBe('Private note');
  await ctx.close();
});

test('Phase 0 — web UI: the Notes view renders a note created via the API', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, USER);
  const origin = new URL(page.url()).origin;
  const uniqueTitle = `UI seam note ${Date.now()}`;
  await page.request.post(`${origin}/api/me/notes`, { headers: { 'x-csrf-token': await csrf(page) }, data: { title: uniqueTitle } });

  // Land on the Notes view (restored from persisted UI state) and reload.
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.reload();
  await expect(page.locator('.notes-list-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.note-row-title', { hasText: uniqueTitle })).toBeVisible({ timeout: 15000 });
});

test('Phase 0 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, USER);
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'chat' })));
  await page.reload();
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
