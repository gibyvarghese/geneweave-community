// Self-contained E2E proving the Upgrade Center degrades gracefully when a data request is rate-limited (HTTP
// 429) instead of crashing. A 429 returns an `{ error }` body, not the expected `{ items }` / `{ entries }` —
// previously the review/attention renderers read `.length` off an undefined array and threw an uncaught
// TypeError that blanked the whole view (the exact stack from the bug report: renderReview → loadQueue).
//
// The 429 is injected deterministically with Playwright route interception (the real edge limiter is bypassed
// under NODE_ENV=test), so this reproduces the failure precisely: every review/attention/run call returns 429.
// The view must survive — no uncaught error, still rendered, with an error banner.
//
// Run:  node scripts/upgrade-429-resilience-e2e.mjs   (from apps/geneweave, after `npm run build`)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { chromium } from 'playwright';
import { createGeneWeave } from '../dist/index.js';

const EMAIL = 'rl-admin@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (n, ok, d = '') => { results.push(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

process.env.PLAYWRIGHT_E2E = '1';
process.env.NODE_ENV = 'test';
process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';

const dbDir = mkdtempSync(join(tmpdir(), 'uc-rl-db-'));
const port = await freePort();
const app = await createGeneWeave({
  port, host: '127.0.0.1', jwtSecret: 'rl-e2e-secret-0123456789ab',
  database: { type: 'sqlite', path: join(dbDir, 'app.db') },
  providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model',
});
const B = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: B });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  // Log in + promote BEFORE arming the 429 (so auth/setup isn't affected).
  await page.goto(B);
  await page.request.post(`${B}/api/auth/register`, { data: { name: 'rl', email: EMAIL, password: PW } });
  await page.request.post(`${B}/api/auth/login`, { data: { email: EMAIL, password: PW } });
  const csrf = (((await (await page.request.get(`${B}/api/auth/me`)).json())).csrfToken) ?? '';
  await page.request.post(`${B}/api/admin/upgrade/_test/promote-admin`, { headers: { 'x-csrf-token': csrf }, data: {} });

  // Arm the rate-limit: every upgrade review/attention/run/status/apply call now returns a 429 `{error}` body —
  // exactly what the edge limiter sends, and exactly the shape the crash depended on.
  const rateLimit = (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests' }) });
  await page.route('**/api/admin/upgrade/review', rateLimit);
  await page.route('**/api/admin/upgrade/attention**', rateLimit);
  await page.route('**/api/admin/upgrade/run', rateLimit);
  await page.route('**/api/admin/upgrade/apply', rateLimit);
  await page.route('**/api/admin/upgrade/status', rateLimit);

  await page.goto(B);
  await page.waitForSelector('.workspace-nav', { timeout: 15000 });
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await page.waitForSelector('h2:has-text("Administration")', { timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible().catch(() => false))) { await page.locator('.admin-parent').click(); await sub.waitFor(); }
  const tab = page.locator('[data-admin-tab="upgrade-center"]').first();
  if (!(await tab.isVisible().catch(() => false))) await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  await tab.click();
  // On mount the Upgrade Center calls loadQueue (GET /review) → 429. This is the exact crash path.
  await page.waitForSelector('[data-upgrade-center]', { timeout: 8000 });
  await page.waitForTimeout(600);
  check('Upgrade Center renders under a 429 (was: uncaught renderReview TypeError)', await page.locator('[data-upgrade-center]').count() > 0);

  // Poke the rate-limited actions that flow through loadQueue / renderReview / renderAttention.
  await page.locator('[data-uc-step="apply"]').click().catch(() => {});   // apply → loadQueue → 429
  await page.waitForTimeout(400);
  await page.locator('[data-uc-attention-load]').click().catch(() => {}); // attention → 429
  await page.waitForTimeout(400);
  if (await page.locator('[data-uc-upgrade]').count()) { await page.locator('[data-uc-upgrade]').click().catch(() => {}); await page.waitForTimeout(400); }

  check('No uncaught page error across the rate-limited flow', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('Review queue still renders (empty, not crashed)', await page.locator('[data-uc-review]').count() > 0);
  check('An error banner is shown to the operator', await page.locator('[data-uc-error]').count() > 0);
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close();
  await app.stop?.();
  rmSync(dbDir, { recursive: true, force: true });
}

console.log('\n════════ Upgrade Center — 429 resilience E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
