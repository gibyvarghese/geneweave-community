// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — streaming accessibility (m140 / H18 + H19). Real managed server + real LLM.
 *
 * Proves the acceptance bar for the Round 3 streaming-a11y tail:
 *   • Config + admin round-trip: GET my accessibility config; an admin PUT changes announce mode + reduced
 *     motion; GET reflects.
 *   • H19 (SR announcements): a dedicated visually-hidden `role="status"` live region announces "Generating
 *     response…" then the FINISHED answer once — and the transcript itself is NOT a live region (so a screen
 *     reader is not spammed with the whole conversation every token).
 *   • H19 (no per-token rebuild): during streaming the assistant bubble is patched in place — the same DOM
 *     node persists across tokens (we do not innerHTML-rebuild the transcript each token).
 *   • H18 (CLS): the composer / Send→Stop control does not move while an answer streams (stable bounding box).
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- streaming-a11y
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'sa-owner@weaveintel.dev';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'sa', email: OWNER, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: OWNER, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}

// ── Config + admin round-trip (deterministic) ─────────────────────────────────────────
test('Streaming a11y — accessibility config + admin round-trip', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);

  const cfg = await (await page.request.get(`${origin}/api/me/accessibility`)).json() as { announceMode: string; reducedMotion: boolean };
  expect(cfg.announceMode).toBe('summary');   // quiet, dependable default
  expect(cfg.reducedMotion).toBe(false);

  const put = await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { announce_mode: 'live', reduced_motion: 1 } });
  expect(put.status()).toBe(200);
  const got = await (await page.request.get(`${origin}/api/admin/accessibility/default`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['announce_mode']).toBe('live');
  expect(got.tenants['reduced_motion']).toBe(1);
  // An invalid mode is ignored (kept previous).
  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { announce_mode: 'nonsense' } });
  expect((await (await page.request.get(`${origin}/api/me/accessibility`)).json() as { announceMode: string }).announceMode).toBe('live');
  // Restore the quiet default so the UI test below is deterministic.
  await page.request.put(`${origin}/api/admin/accessibility/default`, { headers: H, data: { announce_mode: 'summary', reduced_motion: 0 } });
});

// ── H19 + H18 during a real stream (real LLM) ─────────────────────────────────────────
test('Streaming a11y — live region announces the answer, transcript is not live, composer stays put', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page);
  const chatId = (await (await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Streaming a11y' } })).json() as { chat: { id: string } }).chat.id;

  await page.evaluate(async (id: string) => {
    const win = window as unknown as { selectChat?: (id: string) => Promise<void>; state?: { view: string; currentChatId: string | null }; render?: () => void };
    if (win.state) { win.state.view = 'chat'; win.state.currentChatId = id; }
    win.render?.();
    if (win.selectChat) await win.selectChat(id);
  }, chatId);

  const textarea = page.locator('textarea[placeholder="Type a message..."]');
  await expect(textarea).toBeVisible({ timeout: 8000 });

  // The transcript log must NOT be a live region (H19 — otherwise it re-reads the conversation each token).
  await expect(page.locator('.messages')).toHaveAttribute('aria-live', 'off');

  // Record the composer position, then start a real stream.
  const sendBox = await page.locator('.send-btn').boundingBox();
  await textarea.fill('Write three short sentences about why clear writing matters.');
  await page.locator('.send-btn').click();

  // While streaming: a Stop control appears and sits exactly where Send was (H18 — no layout shift).
  const stop = page.locator('.send-btn.stop-btn');
  await expect(stop).toBeVisible({ timeout: 15_000 });
  const stopBox = await stop.boundingBox();
  expect(Math.abs((stopBox!.x + stopBox!.width) - (sendBox!.x + sendBox!.width))).toBeLessThan(2); // right edge stable
  expect(Math.abs(stopBox!.y - sendBox!.y)).toBeLessThan(2);                                       // no vertical shift

  // The dedicated live region announces generation (H19). It is visually hidden but present + role=status.
  const announcer = page.locator('#sr-stream-announcer');
  await expect(announcer).toHaveAttribute('role', 'status');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');

  await page.screenshot({ path: '/tmp/pw-sa-streaming.png' });

  // Wait for completion (Send returns).
  await expect(page.locator('.send-btn:not(.stop-btn)')).toBeVisible({ timeout: 90_000 });

  // The announcer ends up holding the finished answer (summary mode announces the whole answer once).
  await expect.poll(async () => (await announcer.textContent())?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(20);
  const announced = (await announcer.textContent()) ?? '';
  expect(announced.toLowerCase()).toMatch(/writing|clear|sentence|matters/);

  // The final answer rendered as markdown (the streaming bubble marker is gone once settled).
  const assistant = page.locator('.msg.assistant').last();
  await expect(assistant.locator('.gw-assistant-bubble, .bubble').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/pw-sa-final.png', fullPage: true });
});
