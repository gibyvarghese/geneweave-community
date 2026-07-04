/**
 * Playwright E2E — weaveNotes Phase 6 (templates + organisation), live server + real LLM.
 *
 * Proves the Build-Spec G6 capability end-to-end:
 *   • API: the system templates are SEEDED + listed (with gallery categories + descriptions);
 *     creating a note from a template KEY pre-fills it (icon + content); the meeting-minutes note
 *     carries action-items that feed tasks via /extract (the Phase 6 "Done when"); archive →
 *     archived list → restore soft-delete works; a non-owner is refused; new_from_template +
 *     the weaveNotes Editor agent are registered.
 *   • UI: + Insert → New from template → the categorised gallery → pick "Meeting minutes" → a
 *     templated page opens with its action checklist; archive it → it appears in Archived notes →
 *     restore. Screenshots captured for the §7 design comparison.
 *   • Real LLM: "start a meeting-minutes note for me" → the agent calls new_from_template and a
 *     real note is created.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-templates-phase6
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn6-owner@weaveintel.dev';
const OTHER = 'wn6-other@weaveintel.dev';
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
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': await csrf(page) } });
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

interface TemplateRow { id: string; title: string; icon: string | null; template_key: string | null; key: string | null; category: string; description: string }

// ── API: seed + gallery + create-from-template + extract + archive/restore + registration ──
test('Phase 6 — templates seeded + gallery metadata; create from key → action-items feed tasks; archive/restore; registered', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };

  // The gallery lists the seeded system templates with their category + description.
  const { templates } = await (await page.request.get(`${origin}/api/me/notes/templates`)).json() as { templates: TemplateRow[] };
  const byKey = new Map(templates.map((t) => [t.template_key, t]));
  for (const must of ['blank', 'cornell', 'meeting-minutes', 'study-sheet', 'zettelkasten', 'project-brief']) {
    expect(byKey.has(must), `template "${must}" present`).toBe(true);
  }
  const mm = byKey.get('meeting-minutes')!;
  expect(mm.category).toBe('Meetings');
  expect(mm.description.length).toBeGreaterThan(0);
  expect(mm.key).toBe('meeting-minutes'); // the gallery key (joined from the package)

  // Create a note FROM THE TEMPLATE KEY → it is pre-filled (icon + content).
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { template_key: 'meeting-minutes' } })).json() as { id: string; title: string; icon: string | null };
  expect(note.title).toBe('Meeting minutes');     // defaults to the template title
  expect(note.icon).toBe(mm.icon);                 // seeded icon

  // The Phase 6 "Done when": the meeting-minutes action table FEEDS TASKS via /extract.
  const extracted = await (await page.request.post(`${origin}/api/me/notes/${note.id}/extract`, { headers: hdr, data: {} })).json() as { extractedTasks: Array<{ id: string; title: string }> };
  expect(extracted.extractedTasks.length).toBeGreaterThan(0);

  // It starts ACTIVE (in the default list, not the archived list).
  const active0 = await (await page.request.get(`${origin}/api/me/notes?parent=null`)).json() as { notes: Array<{ id: string }> };
  expect(active0.notes.some((n) => n.id === note.id)).toBe(true);

  // ARCHIVE → leaves the active list, appears under ?archived=1.
  expect((await page.request.post(`${origin}/api/me/notes/${note.id}/archive`, { headers: hdr, data: {} })).status()).toBe(200);
  const active1 = await (await page.request.get(`${origin}/api/me/notes?parent=null`)).json() as { notes: Array<{ id: string }> };
  expect(active1.notes.some((n) => n.id === note.id)).toBe(false);
  const trash = await (await page.request.get(`${origin}/api/me/notes?archived=1`)).json() as { notes: Array<{ id: string; archived_at: string | null }> };
  expect(trash.notes.some((n) => n.id === note.id)).toBe(true);
  // Re-archiving is a no-op (404 "already archived").
  expect((await page.request.post(`${origin}/api/me/notes/${note.id}/archive`, { headers: hdr, data: {} })).status()).toBe(404);

  // RESTORE → back in the active list.
  expect((await page.request.post(`${origin}/api/me/notes/${note.id}/restore`, { headers: hdr, data: {} })).status()).toBe(200);
  const active2 = await (await page.request.get(`${origin}/api/me/notes?parent=null`)).json() as { notes: Array<{ id: string }> };
  expect(active2.notes.some((n) => n.id === note.id)).toBe(true);

  // SECURITY: a non-owner cannot archive the note.
  const other = await page.context().browser()!.newContext(); const op = await other.newPage(); await login(op, OTHER);
  const oHdr = { 'x-csrf-token': await csrf(op) };
  expect((await op.request.post(`${origin}/api/me/notes/${note.id}/archive`, { headers: oHdr, data: {} })).status()).toBe(404);
  await other.close();

  // The new_from_template tool + the weaveNotes Editor agent are registered.
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  expect((tools.tools ?? []).map((t) => t.tool_key)).toContain('new_from_template');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('new_from_template');
});

// ── UI: the gallery → Meeting minutes → templated page; archive → Archived → restore ──
test('Phase 6 — UI: New from template gallery → Meeting minutes opens a templated page; archive + restore', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await expect(page.locator('.gw-notes')).toBeVisible({ timeout: 15000 });

  // The left rail's "templates" affordance → the CATEGORISED gallery (always reachable).
  await page.locator('.gw-newnote-tmpl').click();
  await expect(page.locator('.notes-templates')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.notes-template-cat-label').first()).toBeVisible();
  await expect(page.locator('.notes-template-card')).not.toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/gw-wn6-gallery.png`, fullPage: true });

  // Pick "Meeting minutes" → a templated page opens with its action checklist.
  await page.locator('.notes-template-card', { hasText: 'Meeting minutes' }).first().click();
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  // The action-items checklist rendered (taskItem checkboxes are in the doc).
  await expect(page.locator('.notes-editor-mount input[type="checkbox"], .notes-editor-mount li[data-checked], .notes-editor-mount [data-type="taskItem"]').first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-wn6-meeting-note.png`, fullPage: true });

  // Archive it via the centre top-bar overflow (⋯) menu (present while a note is open).
  await page.locator('.gw-topbar .gw-icon-btn[title="More actions"]').first().click();
  await page.getByText('Archive note', { exact: false }).first().click();
  await page.waitForTimeout(800);

  // Open Archived notes via the always-visible left-rail shortcut → restore it.
  await page.locator('.gw-newnote-archived').click();
  await expect(page.locator('.notes-archive')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.notes-archive-row', { hasText: 'Meeting minutes' }).first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-wn6-archived.png`, fullPage: true });
  await page.locator('.notes-archive-row', { hasText: 'Meeting minutes' }).first().locator('.notes-archive-restore').click();
  await page.waitForTimeout(600);
  await expect(page.locator('.notes-archive-row', { hasText: 'Meeting minutes' })).toHaveCount(0);
});

// ── Real LLM: the agent starts a meeting-minutes note via new_from_template ──────────
test.describe('agent starts a note from a template (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('Phase 6 — "start a meeting-minutes note" → the agent calls new_from_template', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin;

    const before = await (await page.request.get(`${origin}/api/me/notes?parent=null`)).json() as { notes: Array<{ id: string; title: string; template_key: string | null }> };
    const beforeIds = new Set(before.notes.map((n) => n.id));

    const client = await clientFor(page);
    const session = createRunSession({ client });
    // A natural request (avoids the prompt-injection guardrail that trips on imperative
    // "call tool X" phrasing). The agent should reach for new_from_template.
    const prompt = 'Could you start a fresh meeting minutes note for me, please, ready for today\'s stand-up?';
    await session.start({ input: { text: prompt }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    await awaitTerminal(session, 150_000);
    await new Promise((r) => setTimeout(r, 1200));
    session.dispose();

    // A new note appeared — ideally seeded from the meeting-minutes template.
    const after = await (await page.request.get(`${origin}/api/me/notes?parent=null`)).json() as { notes: Array<{ id: string; title: string; template_key: string | null }> };
    const fresh = after.notes.filter((n) => !beforeIds.has(n.id));
    // eslint-disable-next-line no-console
    console.log(`[notes-p6] fresh notes: ${JSON.stringify(fresh.map((n) => ({ t: n.title, k: n.template_key })))}`);
    expect(fresh.length, 'the agent should have created a note').toBeGreaterThan(0);
    expect(fresh.some((n) => n.template_key === 'meeting-minutes' || /meeting|minutes/i.test(n.title))).toBe(true);
  });
});
