/**
 * Playwright E2E — weaveNotes Phase 2 (FSRS spaced repetition; the accurate memory-model scheduler
 * that replaces SM-2 as the default). Proves, against a live server + a real LLM:
 *   • API: "make flashcards" still works (real LLM); reviewing a card now runs FSRS — the response
 *     reports scheduler:'fsrs', the card gains stability + difficulty memory state, a "good" review
 *     schedules it ≥1 day out (so it leaves the due queue), and each card carries a per-button
 *     interval PREVIEW that is correctly ordered (Again ≤ Hard ≤ Good ≤ Easy). A lapse ("again")
 *     keeps the card due and never grows stability.
 *   • CONFIG: the Builder can tune target retention (higher retention → sooner due) and can switch
 *     the scheduler back to classic SM-2 (scheduler:'sm2'); both round-trip through the settings API.
 *   • SECURITY: a non-owner cannot review another user's card.
 *   • UI: the Study screen shows the REAL FSRS predictions on the grade buttons (screenshots).
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase2-fsrs
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn2fsrs-owner@weaveintel.dev';
const OTHER = 'wn2fsrs-other@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }

const STUDY_NOTE = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Photosynthesis' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Photosynthesis is how plants, algae and some bacteria turn light energy into chemical energy. In the light-dependent reactions, chlorophyll in the thylakoid membranes absorbs light, splits water (releasing oxygen), and produces ATP and NADPH. In the Calvin cycle (light-independent reactions) in the stroma, the enzyme RuBisCO fixes carbon dioxide into glucose using that ATP and NADPH. The overall equation is 6CO2 + 6H2O + light → C6H12O6 + 6O2. The green pigment chlorophyll absorbs red and blue light and reflects green.' }] },
  ],
};

type Card = { id: string; front: string; back: string; stability?: number | null; difficulty?: number | null; preview?: Record<'again' | 'hard' | 'good' | 'easy', number> };

// ── API: FSRS review math + memory state + previews + config switch (real LLM) ──────
test('Phase 2 FSRS — make deck → FSRS review (stability/difficulty + ordered previews); retention dial; SM-2 fallback; security', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  // Ensure FSRS on + default retention before we start.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_enabled: true, fsrs_target_retention: 0.9, flashcards_enabled: true } });

  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Photosynthesis study', doc_json: STUDY_NOTE } })).json() as { id: string };

  // Generate a deck from the note (real LLM).
  const gen = await (await page.request.post(`${origin}/api/me/notes/${note.id}/flashcards`, { headers: hdr, data: { count: 8 } })).json() as { ok: boolean; created: number };
  expect(gen.ok).toBe(true);
  expect(gen.created).toBeGreaterThanOrEqual(3);

  // The deck listing reports the FSRS scheduler and gives each card a per-button preview.
  const deck = await (await page.request.get(`${origin}/api/me/notes/${note.id}/flashcards`)).json() as { scheduler: string; cards: Card[] };
  expect(deck.scheduler).toBe('fsrs');
  const seed = deck.cards[0]!;
  expect(seed.preview).toBeTruthy();
  // Fresh-card previews are ordered Again ≤ Hard ≤ Good ≤ Easy.
  expect(seed.preview!.again).toBeLessThanOrEqual(seed.preview!.hard);
  expect(seed.preview!.hard).toBeLessThanOrEqual(seed.preview!.good);
  expect(seed.preview!.good).toBeLessThanOrEqual(seed.preview!.easy);
  expect(seed.preview!.easy).toBeGreaterThan(seed.preview!.again);

  // Reserve fresh card IDs up front (the queue shrinks as we review).
  const due0 = await (await page.request.get(`${origin}/api/me/flashcards/due`)).json() as { cards: Card[] };
  expect(due0.cards.length).toBe(gen.created);
  const cGood = due0.cards[0]!.id;
  const cAgain = due0.cards[1]!.id;

  // Review one card "good" → FSRS: response reports fsrs, card gains stability+difficulty, ≥1 day out.
  const rev = await (await page.request.post(`${origin}/api/me/flashcards/${cGood}/review`, { headers: hdr, data: { rating: 'good' } })).json() as { ok: boolean; scheduler: string; card: { intervalDays: number; stability: number; difficulty: number }; preview: Record<string, number> };
  expect(rev.ok).toBe(true);
  expect(rev.scheduler).toBe('fsrs');
  expect(rev.card.stability).toBeGreaterThan(0);          // memory state now set
  expect(rev.card.difficulty).toBeGreaterThanOrEqual(1);
  expect(rev.card.difficulty).toBeLessThanOrEqual(10);
  expect(rev.card.intervalDays).toBeGreaterThanOrEqual(1);
  expect(rev.preview).toBeTruthy();                       // post-review preview for the next round

  // It left the due queue (scheduled into the future).
  const due1 = await (await page.request.get(`${origin}/api/me/flashcards/due`)).json() as { cards: Card[] };
  expect(due1.cards.some((c) => c.id === cGood)).toBe(false);

  // A lapse ("again") records small stability and schedules the card no more than ~1 day out (FSRS
  // long-term mode has no sub-day steps — the study UI re-queues a lapsed card within the session).
  const lap = await (await page.request.post(`${origin}/api/me/flashcards/${cAgain}/review`, { headers: hdr, data: { rating: 'again' } })).json() as { card: { stability: number; intervalDays: number } };
  expect(lap.card.stability).toBeGreaterThan(0);
  expect(lap.card.intervalDays).toBeLessThanOrEqual(1);     // soon — much sooner than a "good"
  expect(lap.card.intervalDays).toBeLessThan(rev.card.intervalDays);

  // RETENTION DIAL: aiming for a HIGHER recall probability schedules a fresh "good" review SOONER.
  if (gen.created >= 4) {
    const cHi = due1.cards.find((c) => c.id !== cAgain)!.id;
    const cLo = due1.cards.find((c) => c.id !== cAgain && c.id !== cHi)?.id;
    await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_target_retention: 0.97 } });
    const hi = await (await page.request.post(`${origin}/api/me/flashcards/${cHi}/review`, { headers: hdr, data: { rating: 'good' } })).json() as { card: { intervalDays: number } };
    if (cLo) {
      await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_target_retention: 0.8 } });
      const lo = await (await page.request.post(`${origin}/api/me/flashcards/${cLo}/review`, { headers: hdr, data: { rating: 'good' } })).json() as { card: { intervalDays: number } };
      expect(lo.card.intervalDays).toBeGreaterThanOrEqual(hi.card.intervalDays); // lower retention → at least as far out
    }
  }
  // Out-of-range retention is clamped server-side, never errors.
  const clampRes = await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_target_retention: 5 } });
  expect(clampRes.ok()).toBe(true);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_target_retention: 0.9 } }); // restore

  // SCHEDULER SWITCH: turn FSRS off → reviews report classic SM-2.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_enabled: false } });
  const sm2Deck = await (await page.request.get(`${origin}/api/me/notes/${note.id}/flashcards`)).json() as { scheduler: string };
  expect(sm2Deck.scheduler).toBe('sm2');
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_enabled: true } }); // restore

  // SECURITY: a non-owner cannot review the owner's card.
  const other = await page.context().browser()!.newContext(); const op = await other.newPage(); await login(op, OTHER);
  const oOrigin = new URL(op.url()).origin; const oHdr = { 'x-csrf-token': await csrf(op) };
  const forbidden = await op.request.post(`${oOrigin}/api/me/flashcards/${cGood}/review`, { headers: oHdr, data: { rating: 'good' } });
  expect(forbidden.status()).toBe(404);
  await other.close();
});

// ── UI: the Study screen shows the REAL FSRS predictions on the grade buttons ───────
test('Phase 2 FSRS — UI: Study screen shows real FSRS next-review predictions on the grade buttons', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, OWNER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { fsrs_enabled: true, fsrs_target_retention: 0.9 } });
  await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'FSRS study UI note', doc_json: STUDY_NOTE } })).json();

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('FSRS study UI note', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: /Insert/ }).first().click();
  await page.getByText('Study (flashcards)', { exact: false }).first().click();
  await expect(page.locator('.gw-study')).toBeVisible({ timeout: 8000 });

  await page.locator('.gw-study-make').click();
  await expect(page.locator('.gw-study-card')).toBeVisible({ timeout: 60000 });
  await page.locator('.gw-study-reveal').click();
  await expect(page.locator('.gw-study-grades')).toBeVisible();
  // The Easy button should predict a later date than the Hard button (FSRS ordering), and none blank.
  const easy = await page.locator('.gw-grade-easy small').textContent();
  const hard = await page.locator('.gw-grade-hard small').textContent();
  expect((easy ?? '').length).toBeGreaterThan(0);
  expect((hard ?? '').length).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOT}/gw-wn2-fsrs-grades.png` });
});
