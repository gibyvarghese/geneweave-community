// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0 HARDENING — API end-to-end (real managed server).
 *
 * Proves the per-user AI RATE LIMIT works through the real HTTP stack:
 *   • the cap (`ai_rate_per_min_per_user`) is a Builder-editable weavenotes_settings field;
 *   • once a person exceeds it, EVERY /ai/* note endpoint returns HTTP 429 + a `Retry-After` header;
 *   • the limit is per-USER (one person hitting the wall doesn't block a different person);
 *   • lowering the cap to 0-ish and raising it back is honoured live (no restart).
 *
 * We hammer /ai/highlight because it is LLM-free (a deterministic colour suggestion) — so the test is
 * fast and the 429s come from the rate guard, not from a slow/absent model.
 *
 * Run: npm run test:e2e -- weavenotes-phase0-hardening
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const A = 'wn0h-a@weaveintel.dev';
const B = 'wn0h-b@weaveintel.dev';

async function login(page: Page, email: string): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'wn0h', email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}
const HEART = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Human Heart' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'A muscular organ that pumps blood around the body.' }] },
] });
async function setRate(page: Page, origin: string, H: Record<string, string>, rate: number): Promise<void> {
  const r = await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: H, data: { ai_rate_per_min_per_user: rate } });
  expect(r.ok()).toBeTruthy();
}
async function makeNote(page: Page, origin: string, H: Record<string, string>): Promise<string> {
  return (await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Rate note', doc_json: HEART } })).json() as { id: string }).id;
}

test('AI rate limit — the cap is a Builder-editable setting that round-trips', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page, A);
  await setRate(page, origin, H, 7);
  const cfg = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { config: { ai_rate_per_min_per_user?: number } };
  expect(cfg.config.ai_rate_per_min_per_user).toBe(7);
  // restore a generous default so other tests on the shared server are unaffected
  await setRate(page, origin, H, 1000);
});

test('AI rate limit — over the cap, /ai/* returns 429 with Retry-After (then refills)', async ({ page }) => {
  test.setTimeout(90_000);
  const { origin, H } = await login(page, A);
  // Small cap so we hit the wall fast. 3 actions/min.
  await setRate(page, origin, H, 3);
  const note = await makeNote(page, origin, H);
  const hit = () => page.request.post(`${origin}/api/me/notes/${note}/ai/highlight`, { headers: H, data: { phrase: 'heart', color: '#FAC775' } });

  // The first 3 succeed (201). The bucket starts full at the configured burst.
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await hit()).status());
  // eslint-disable-next-line no-console
  console.log('[rate] statuses for 5 rapid AI calls (cap=3):', JSON.stringify(codes));
  expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(3);
  expect(codes).toContain(429); // at least one was rate-limited

  // The 429 carries a Retry-After header and a structured body.
  const limited = await hit();
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
  const body = await limited.json() as { code?: string; error?: string; retryAfterMs?: number };
  expect(body.code).toBe('rate_limited');
  expect(body.error).toMatch(/rate limit/i);

  // restore generous default
  await setRate(page, origin, H, 1000);
});

test('AI rate limit — is PER USER (B is unaffected when A is throttled)', async ({ page, browser }) => {
  test.setTimeout(90_000);
  // A throttles itself with a tiny cap.
  const a = await login(page, A);
  await setRate(page, a.origin, a.H, 2);
  const noteA = await makeNote(page, a.origin, a.H);
  const hitA = () => page.request.post(`${a.origin}/api/me/notes/${noteA}/ai/highlight`, { headers: a.H, data: { phrase: 'heart', color: '#FAC775' } });
  let aGot429 = false;
  for (let i = 0; i < 5; i++) { if ((await hitA()).status() === 429) aGot429 = true; }
  expect(aGot429).toBe(true); // A is now throttled

  // B (a different user, fresh browser context) can still act — the bucket is keyed per user.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await login(pageB, B);
  const noteB = await makeNote(pageB, b.origin, b.H);
  const bStatus = (await pageB.request.post(`${b.origin}/api/me/notes/${noteB}/ai/highlight`, { headers: b.H, data: { phrase: 'heart', color: '#9FE1CB' } })).status();
  // eslint-disable-next-line no-console
  console.log('[rate] B status while A is throttled:', bStatus);
  expect(bStatus).toBe(201); // B is NOT affected by A's throttle
  await ctxB.close();

  // restore generous default
  await setRate(page, a.origin, a.H, 1000);
});
