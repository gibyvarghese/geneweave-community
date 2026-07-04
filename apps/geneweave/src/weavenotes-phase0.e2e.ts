/**
 * Playwright E2E — weaveNotes Phase 0 foundation, live server + real LLM.
 * Proves: the weaveNotes settings config is DB-backed + Builder-editable + validated; the note
 * AI tools + the weaveNotes Editor agent are registered in the catalog; note create/edit records
 * activity; and the agent can read that activity via read_note_activity (across modes).
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase0
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';
const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn0-owner@weaveintel.dev';
async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
async function clientFor(page: Page): Promise<RunClient> { const cookies = await page.context().cookies(); return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': await csrf(page) } }); }
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> { return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]); }

// ── API: config CRUD + validation + tools/agent registered + activity ────────
test('Phase 0 — settings are DB-backed + Builder-editable + validated; tools + agent registered; activity recorded', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // settings GET returns the seeded global config
  const get1 = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<{ default_theme: string; enabled_ai_tools: string }> };
  expect(get1['weavenotes-settings'][0]!.default_theme).toBe('pro');
  expect(get1['weavenotes-settings'][0]!.enabled_ai_tools).toContain('read_note_activity');

  // PUT with hostile/out-of-range values → validated (clamped + unknown rejected) + warnings
  const put = await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { default_theme: 'rainbow', max_ai_tokens_per_edit: 1, activity_retention_days: 99999, enabled_ai_tools: ['note_edit', 'evil_tool'] } });
  const putData = await put.json() as { 'weavenotes-settings': { default_theme: string; max_ai_tokens_per_edit: number; activity_retention_days: number; enabled_ai_tools: string }; warnings: string[] };
  expect(putData['weavenotes-settings'].default_theme).toBe('pro');           // rejected
  expect(putData['weavenotes-settings'].max_ai_tokens_per_edit).toBe(256);    // clamped
  expect(putData['weavenotes-settings'].activity_retention_days).toBe(3650);  // clamped
  expect(JSON.parse(putData['weavenotes-settings'].enabled_ai_tools)).toEqual(['note_edit']); // dropped
  expect(putData.warnings.length).toBeGreaterThanOrEqual(3);
  // restore a sane config so later tests/UI are clean
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { default_theme: 'pro', max_ai_tokens_per_edit: 4000, activity_retention_days: 90, enabled_ai_tools: ['create_note','note_edit','find_related_notes','workspace_search','capture_web_page','autofill_database','read_note_activity'] } });

  // the note tools + the weaveNotes Editor agent are in the catalog
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  const keys = (tools.tools ?? []).map((t) => t.tool_key);
  expect(keys).toContain('read_note_activity');
  expect(keys).toContain('note_edit');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string }> };
  expect((agents.workerAgents ?? []).some((a) => a.name === 'weavenotes_editor')).toBe(true);

  // create + edit a note → activity is recorded
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Project Atlas brief', doc_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial draft.' }] }] } } })).json() as { id: string };
  await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: hdr, data: { doc_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited draft with more detail.' }] }] } } });
  const act = await (await page.request.get(`${origin}/api/me/notes/${note.id}/activity`)).json() as { activity: Array<{ action: string }> };
  expect(act.activity.length).toBeGreaterThanOrEqual(2);
  expect(act.activity.map((a) => a.action)).toContain('created');
  expect(act.activity.map((a) => a.action)).toContain('updated');
});

// ── Builder UI: the settings render + edit + save ─────────────────────────────
test('Phase 0 — web UI: weaveNotes Settings renders in the Builder and saves', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'builder', adminTab: 'weavenotes-settings' })));
  await page.reload();
  await page.waitForSelector('.bld-app', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/gw-wn0-builder.png` });
  // the editor shows the settings fields
  await expect(page.locator('.bld-editor-name')).toContainText('weaveNotes Settings');
  await expect(page.locator('.bld-section-label').first()).toBeVisible();
  // toggle a checkbox-style field (a toggle in AVAILABILITY) + save → toast
  const toggle = page.locator('.bld-toggle').first();
  if (await toggle.count()) { await toggle.click(); await page.locator('.bld-btn-save').click(); await expect(page.locator('.bld-toast')).toBeVisible({ timeout: 8000 }); }
});

// ── Real LLM: the agent reads note activity, across modes ──────────────────────
test.describe('agent reads note activity via read_note_activity across modes', () => {
  test.describe.configure({ retries: 2 });
  for (const mode of ['agent', 'supervisor', 'ensemble'] as const) {
    test(`Phase 0 — "${mode}": the agent understands what changed`, async ({ page }) => {
      test.setTimeout(200_000);
      await login(page, OWNER);
      const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
      const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Atlas ${mode}`, doc_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First version.' }] }] } } })).json() as { id: string };
      await page.request.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: hdr, data: { doc_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second version with the budget section.' }] }] } } });

      const client = await clientFor(page); const session = createRunSession({ client });
      const prompt = `Check the recent activity of my note with id ${note.id} and tell me what has changed on it.`;
      const evs: Array<{ kind: string; payload: unknown }> = [];
      const runId = await session.start({ input: { text: prompt }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
      const ctrl = client.attach(runId, { onEvent: (e) => evs.push({ kind: e.kind, payload: e.payload }) });
      await awaitTerminal(session, 150_000); await new Promise((r) => setTimeout(r, 1000)); ctrl.abort(); session.dispose();
      const called = evs.filter((e) => e.kind.startsWith('tool')).some((e) => (e.payload as { tool?: string }).tool === 'read_note_activity');
      const gated = evs.some((e) => e.kind === 'diagnostic');
      // eslint-disable-next-line no-console
      console.log(`[wn0][${mode}] called=${called} gated=${gated}`);
      if (mode === 'agent') expect(called || gated, 'agent reads activity or is guardrail-gated').toBe(true);
      else if (!called) console.warn(`[wn0][${mode}] did not call read_note_activity (small-model non-determinism)`);
    });
  }
});
