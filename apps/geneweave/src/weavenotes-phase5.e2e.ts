/**
 * Playwright E2E — weaveNotes Phase 5 (AI study: flashcards + SM-2 spaced repetition).
 * Proves, against a live server + a real LLM:
 *   • API: "make flashcards from this note" generates a deck (real LLM) with study stats; reviewing
 *     a card applies SM-2 (a "good" review reschedules it to tomorrow, so it LEAVES the due queue);
 *     the cross-note due queue works; flashcards are CONFIG-GATED; the make_flashcards tool + the
 *     weaveNotes Editor agent are registered; a non-owner is refused.
 *   • UI: open a note → Study → Make flashcards → review (show answer → grade) on the SM-2 screen.
 *     Screenshots captured for the active-recall design comparison.
 *   • The Phase 5 "Done when": a reviewable deck on a schedule.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase5
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn5-owner@weaveintel.dev';
const OTHER = 'wn5-other@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }

const STUDY_NOTE = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The human heart' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'The human heart has four chambers: the right and left atria (upper) and the right and left ventricles (lower). Deoxygenated blood enters the right atrium, passes to the right ventricle, and is pumped to the lungs. Oxygenated blood returns to the left atrium, passes to the left ventricle, and is pumped to the body through the aorta. Four valves keep blood flowing one way: the tricuspid, pulmonary, mitral, and aortic valves. The heart beats about 100,000 times a day.' }] },
  ],
};

// ── API: generate deck, SM-2 review, due queue, gating, registration (real LLM) ─────
test('Phase 5 — make flashcards → deck + stats; SM-2 review reschedules; gating; registered', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  // This test pins the classic SM-2 scheduler (FSRS is the default since Phase 2; FSRS has its own e2e).
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_enabled: false } });
  const cfgCheck = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { config?: { fsrs_enabled?: number } };
  expect(cfgCheck.config?.fsrs_enabled).toBe(0); // the scheduler is now SM-2
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Heart study', doc_json: STUDY_NOTE } })).json() as { id: string };

  // Generate flashcards from the note.
  const gen = await (await page.request.post(`${origin}/api/me/notes/${note.id}/flashcards`, { headers: hdr, data: { count: 8 } })).json() as { ok: boolean; created: number; stats: { total: number; due: number; fresh: number } };
  expect(gen.ok).toBe(true);
  expect(gen.created).toBeGreaterThanOrEqual(3);
  expect(gen.stats.due).toBe(gen.created);    // fresh cards are all due now
  expect(gen.stats.fresh).toBe(gen.created);

  // The note's deck + the cross-note due queue both list them.
  const deck = await (await page.request.get(`${origin}/api/me/notes/${note.id}/flashcards`)).json() as { cards: Array<{ id: string; front: string; back: string }>; stats: { total: number } };
  expect(deck.cards.length).toBe(gen.created);
  expect(deck.cards[0]!.front.length).toBeGreaterThan(0);
  const due0 = await (await page.request.get(`${origin}/api/me/flashcards/due`)).json() as { cards: Array<{ id: string }> };
  expect(due0.cards.length).toBe(gen.created);

  // Review ONE card "good" → SM-2 schedules it ~1 day out → it leaves the due queue.
  const cardId = due0.cards[0]!.id;
  const rev = await (await page.request.post(`${origin}/api/me/flashcards/${cardId}/review`, { headers: hdr, data: { rating: 'good' } })).json() as { ok: boolean; card: { intervalDays: number; repetitions: number } };
  expect(rev.ok).toBe(true);
  expect(rev.card.repetitions).toBe(1);
  expect(rev.card.intervalDays).toBe(1); // first "good" → tomorrow
  const due1 = await (await page.request.get(`${origin}/api/me/flashcards/due`)).json() as { cards: Array<{ id: string }> };
  expect(due1.cards.length).toBe(gen.created - 1); // the reviewed card is no longer due
  expect(due1.cards.some((c) => c.id === cardId)).toBe(false);

  // An "again" review keeps a card due today (relearn).
  const card2 = due1.cards[0]!.id;
  await page.request.post(`${origin}/api/me/flashcards/${card2}/review`, { headers: hdr, data: { rating: 'again' } });
  const due2 = await (await page.request.get(`${origin}/api/me/flashcards/due`)).json() as { cards: Array<{ id: string }> };
  expect(due2.cards.some((c) => c.id === card2)).toBe(true); // still due

  // CONFIG GATING: disable flashcards → generation is refused; flag persists + is Builder-editable.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { flashcards_enabled: false } });
  const refused = await (await page.request.post(`${origin}/api/me/notes/${note.id}/flashcards`, { headers: hdr, data: {} })).json() as { ok: boolean; error?: string };
  expect(refused.ok).toBe(false);
  expect(String(refused.error)).toContain('disabled');
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { flashcards_enabled: true } }); // restore

  // SECURITY: a non-owner cannot make flashcards from the note.
  const other = await page.context().browser()!.newContext(); const op = await other.newPage(); await login(op, OTHER);
  const oOrigin = new URL(op.url()).origin; const oHdr = { 'x-csrf-token': await csrf(op) };
  const forbidden = await op.request.post(`${oOrigin}/api/me/notes/${note.id}/flashcards`, { headers: oHdr, data: {} });
  expect(forbidden.status()).toBe(404);
  await other.close();

  // The make_flashcards tool + the agent are registered.
  const tools = await (await page.request.get(`${origin}/api/admin/tool-catalog`)).json() as { tools?: Array<{ tool_key?: string }> };
  expect((tools.tools ?? []).map((t) => t.tool_key)).toContain('make_flashcards');
  const agents = await (await page.request.get(`${origin}/api/admin/worker-agents`)).json() as { workerAgents?: Array<{ name?: string; tool_names?: string }> };
  expect((agents.workerAgents ?? []).find((a) => a.name === 'weavenotes_editor')?.tool_names).toContain('make_flashcards');
});

// ── UI: the Study screen — make + review flashcards (real LLM) ──────────────────────
test('Phase 5 — UI: Study → Make flashcards → review (show answer + grade) on the SM-2 screen', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Study UI note', doc_json: STUDY_NOTE } })).json();

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Study UI note', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);

  // Open "+ Insert" → "Study (flashcards)".
  await page.getByRole('button', { name: /Insert/ }).first().click();
  await page.getByText('Study (flashcards)', { exact: false }).first().click();
  await expect(page.locator('.gw-study')).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-wn5-empty.png` });

  // Make flashcards (real LLM) → the review screen shows the first card.
  await page.locator('.gw-study-make').click();
  await expect(page.locator('.gw-study-card')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.gw-study-q')).not.toBeEmpty();
  await page.screenshot({ path: `${SHOT}/gw-wn5-card.png` });

  // Reveal the answer + grade it "Good" → advance.
  await page.locator('.gw-study-reveal').click();
  await expect(page.locator('.gw-study-a')).toBeVisible();
  await expect(page.locator('.gw-study-grades')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/gw-wn5-revealed.png` });
  const firstQ = await page.locator('.gw-study-q').textContent();
  await page.locator('.gw-grade-good').click();
  await page.waitForTimeout(700);
  // Either the next card shows (different question) or the deck is done.
  const done = await page.locator('.gw-study-empty').count();
  if (done === 0) { expect(await page.locator('.gw-study-q').textContent()).not.toBe(firstQ); }
});
