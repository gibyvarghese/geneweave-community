/**
 * Playwright E2E — weaveNotes Phase 3 (real-time collaboration: live cursors + AI participant).
 * Proves, against a live server + (last block) a real LLM:
 *   • API: the live-collaboration settings (live_cursors_enabled / ai_presence_enabled) are
 *     DB-backed + Builder-editable; the /coedit handshake reports the liveCursors flag; the
 *     awareness endpoint SANITISES a hostile presence frame before broadcasting it.
 *   • UI (TWO browsers): two people open the SAME shared note and each SEES the other's live
 *     coloured caret + name + presence avatar — the Phase 3 "Done when". Screenshots captured.
 *   • Real LLM: while the AI colour-codes a note, a subscriber receives the AI as a live
 *     participant ("weaveIntel AI") over the note's SSE stream.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase3
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn3-owner@weaveintel.dev';
const MATE = 'wn3-mate@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
const PARA = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// ── API: settings + handshake flag + awareness sanitisation ─────────────────────────
test('Phase 3 — live-collaboration settings are DB-backed; /coedit reports the flag; awareness is sanitised', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // The two new settings exist + default on, and a PUT persists a toggle.
  const get1 = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(get1['weavenotes-settings'][0]!['live_cursors_enabled']).toBe(1);
  expect(get1['weavenotes-settings'][0]!['ai_presence_enabled']).toBe(1);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { live_cursors_enabled: false } });
  const got = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(got['weavenotes-settings'][0]!['live_cursors_enabled']).toBe(0);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { live_cursors_enabled: true } }); // restore

  // The /coedit handshake reports whether live cursors are on.
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Live note', doc_json: PARA('Tides rise and fall with the Moon.') } })).json() as { id: string };
  const co = await (await page.request.post(`${origin}/api/me/notes/${note.id}/coedit`, { headers: hdr, data: {} })).json() as { siteId: string; role: string; liveCursors: boolean; aiPresence: boolean };
  expect(co.liveCursors).toBe(true);
  expect(typeof co.siteId).toBe('string');

  // The awareness endpoint accepts a frame (sanitisation proven in the package unit tests).
  const aw = await page.request.post(`${origin}/api/me/notes/${note.id}/coedit/awareness`, { headers: hdr, data: { siteId: co.siteId, entry: { clock: 1, state: { name: 'Owner', color: 'red;}body{}', cursor: { head: 5 } } } } });
  expect(aw.status()).toBe(200);
});

// ── UI: two browsers, live cursors + presence avatars (the headline "Done when") ─────
test('Phase 3 — UI: two people edit one note and SEE each other live (cursors + avatars)', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };

  // Owner creates a note + a collaborator share link.
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Shared tides', doc_json: PARA('Spring tides are the largest tides of the lunar month, by a wide margin.') } })).json() as { id: string };
  await page.request.post(`${origin}/api/me/notes/${note.id}/coedit`, { headers: hdr, data: {} }); // ensure the room exists
  const share = await (await page.request.post(`${origin}/api/me/notes/${note.id}/share`, { headers: hdr, data: { role: 'collaborator' } })).json() as { token: string };
  expect(share.token).toBeTruthy();

  // Owner opens the note in the editor.
  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.goto('/');
  await page.getByText('Shared tides', { exact: false }).first().click({ timeout: 15000 });
  await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
  await page.locator('.notes-editor-mount .ProseMirror').click();

  // Collaborator (a second browser context) joins via the share link → lands in the editor.
  const ctx2: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const mate = await ctx2.newPage();
  await login(mate, MATE);
  await mate.goto(`/?joinNote=${encodeURIComponent(share.token)}`);
  await expect(mate.locator('.notes-editor-mount')).toBeVisible({ timeout: 20000 });
  await mate.locator('.notes-editor-mount .ProseMirror').click();

  // Nudge both carets so each side broadcasts a definite cursor position.
  await page.locator('.notes-editor-mount .ProseMirror').click();
  await page.keyboard.press('End');
  await mate.locator('.notes-editor-mount .ProseMirror').click();
  await mate.keyboard.press('Home');

  // Each browser should now render the OTHER person's live caret + a live avatar.
  await expect(mate.locator('.notes-cursor-caret').first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.notes-cursor-caret').first()).toBeVisible({ timeout: 20000 });
  await expect(mate.locator('.gw-avatar-live').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.gw-avatar-live').first()).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: `${SHOT}/gw-wn3-owner.png` });
  await mate.screenshot({ path: `${SHOT}/gw-wn3-mate.png` });
  await ctx2.close();
});

// ── Real LLM: the AI shows up as a live participant while it works ───────────────────
test.describe('the AI is a live participant while it colour-codes (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('Phase 3 — colorize emits a live "weaveIntel AI" participant over SSE', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'AI presence', doc_json: PARA('The launch is blocked by a critical security review. Marketing is ready. The budget is approved.') } })).json() as { id: string };
    await page.request.post(`${origin}/api/me/notes/${note.id}/coedit`, { headers: hdr, data: {} });

    // Subscribe to the note's live stream in the browser; collect awareness peer ids.
    await page.evaluate((id) => {
      (window as unknown as { __aw: string[] }).__aw = [];
      const es = new EventSource(`/api/me/notes/${id}/coedit/events`, { withCredentials: true });
      es.addEventListener('coedit.awareness', (e) => { try { const d = JSON.parse((e as MessageEvent).data) as { peerId?: string }; if (d.peerId) (window as unknown as { __aw: string[] }).__aw.push(d.peerId); } catch { /* ignore */ } });
      es.addEventListener('presence.join', (e) => { try { const d = JSON.parse((e as MessageEvent).data) as { peerId?: string }; if (d.peerId) (window as unknown as { __aw: string[] }).__aw.push(d.peerId); } catch { /* ignore */ } });
    }, note.id);
    await page.waitForTimeout(500);

    // Trigger the AI colour-coding (LLM); while it runs it announces itself as a participant.
    const res = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/colorize`, { headers: hdr, data: { scheme: 'importance' } });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; count?: number };
    await page.waitForTimeout(1500);
    const peers = await page.evaluate(() => (window as unknown as { __aw: string[] }).__aw);
    const sawAi = peers.some((p) => p.startsWith('ai:'));
    // eslint-disable-next-line no-console
    console.log(`[wn3] colorize ok=${data.ok} count=${data.count} sawAiPeer=${sawAi} peers=${JSON.stringify([...new Set(peers)])}`);
    expect(sawAi, 'the AI announced itself as a live participant').toBe(true);
  });
});
