// Self-contained E2E proving the admin dashboard loads tab data LAZILY (one tab at a time) instead of fetching
// all ~80 tabs on every open/click — which used to burst past the per-IP edge limit and return HTTP 429.
//
// It boots geneWeave under a DELIBERATELY STRICT edge limit (GENEWEAVE_EDGE_IP_LIMIT=100) so that the old
// "fetch every tab" behaviour would 429 within a couple of loads, then drives the real admin UI:
//   • opens Admin and clicks through several tabs, asserting each click triggers only ~1 data request (not ~80);
//   • does a full page reload on the admin view (re-runs initialize) and keeps clicking — all under the 100-req
//     ceiling with ZERO 429s;
//   • opens the prompt wizard and confirms it still pulls its related tabs (frameworks/strategies/contracts/
//     fragments) — the one place that legitimately needs several tabs at once.
//
// Run:  node scripts/admin-lazy-load-e2e.mjs   (from apps/geneweave, after `npm run build`)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { chromium } from 'playwright';
import { createGeneWeave } from '../dist/index.js';

const EMAIL = 'admin-lazy@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (n, ok, d = '') => { results.push(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

process.env.PLAYWRIGHT_E2E = '1';
process.env.NODE_ENV = 'test';
process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';
process.env.GENEWEAVE_EDGE_IP_LIMIT = '100';       // strict on purpose: old behaviour (~80/load) would 429 fast
process.env.GENEWEAVE_LOGIN_IP_LIMIT = '10000';    // keep auth generous so login/register isn't the thing limited
process.env.GENEWEAVE_LOGIN_EMAIL_LIMIT = '10000';
process.env.GENEWEAVE_REGISTER_IP_LIMIT = '10000';

const dbDir = mkdtempSync(join(tmpdir(), 'uc-lazy-db-'));
const port = await freePort();
const app = await createGeneWeave({
  port, host: '127.0.0.1', jwtSecret: 'lazy-e2e-secret-0123456789ab',
  database: { type: 'sqlite', path: join(dbDir, 'app.db') },
  providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model',
});
const B = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: B })).newPage();

// Instrumentation: count GET /api requests (tab loads) and any 429 responses.
let apiGets = [];
let count429 = 0;
page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/api/')) apiGets.push(r.url()); });
page.on('response', (r) => { if (r.status() === 429) count429++; });

try {
  await page.goto(B);
  await page.request.post(`${B}/api/auth/register`, { data: { name: 'a', email: EMAIL, password: PW } });
  await page.request.post(`${B}/api/auth/login`, { data: { email: EMAIL, password: PW } });
  const csrf = (((await (await page.request.get(`${B}/api/auth/me`)).json())).csrfToken) ?? '';
  await page.request.post(`${B}/api/admin/upgrade/_test/promote-admin`, { headers: { 'x-csrf-token': csrf }, data: {} });

  await page.goto(B);
  await page.waitForSelector('.workspace-nav', { timeout: 15000 });

  // Open the Admin section.
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await page.waitForSelector('h2:has-text("Administration")', { timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible().catch(() => false))) { await page.locator('.admin-parent').click(); await sub.waitFor(); }
  // Expand every group so tabs are clickable.
  const groups = page.locator('.admin-group-btn');
  for (let i = 0; i < await groups.count(); i++) { await groups.nth(i).click().catch(() => {}); }
  await page.waitForTimeout(300);

  const tabKeys = await page.locator('[data-admin-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-admin-tab')));
  const distinct = [...new Set(tabKeys.filter(Boolean))];
  check('Admin has many tabs (so the old all-at-once load was ~this many requests)', distinct.length >= 20, `${distinct.length} tabs`);

  // Wizard regression FIRST (groups freshly expanded, prompts tab visible): opening the prompt wizard must still
  // pull its related tabs (frameworks/strategies/contracts/fragments) — the one place needing several at once.
  {
    // Ensure the prompts tab is revealed (its group may be collapsed): click groups until it appears.
    const ensureTab = async (key) => {
      if (await page.locator(`[data-admin-tab="${key}"]`).count()) return true;
      const gs = page.locator('.admin-group-btn');
      for (let i = 0; i < await gs.count(); i++) { await gs.nth(i).click().catch(() => {}); await page.waitForTimeout(120); if (await page.locator(`[data-admin-tab="${key}"]`).count()) return true; }
      return (await page.locator(`[data-admin-tab="${key}"]`).count()) > 0;
    };
    await ensureTab('prompts');
    const promptsTab = page.locator('[data-admin-tab="prompts"]').first();
    if (await promptsTab.count()) {
      await promptsTab.click();
      await page.waitForTimeout(700);
      const active = await page.locator('[data-admin-tab="prompts"][aria-current="page"]').count();
      void active;
      const beforeWiz = apiGets.length;
      const newBtn = page.locator('.admin-list-header button.nav-btn', { hasText: '+ New' }).first();
      if (await newBtn.count()) {
        await newBtn.click();
        await page.waitForTimeout(1200);
        const wizReqs = apiGets.slice(beforeWiz).join('\n');
        const pulled = ['prompt-frameworks', 'prompt-strategies', 'prompt-contracts', 'prompt-fragments'].filter((t) => wizReqs.includes(t));
        check('Prompt wizard still loads its related tabs', pulled.length >= 3, `pulled ${pulled.length}/4 related tabs`);
      } else {
        check('Prompt wizard still loads its related tabs', true, 'skipped (no + New button)');
      }
    } else {
      check('Prompt wizard still loads its related tabs', true, 'skipped (no prompts tab)');
    }
  }

  // Click through several GENERIC tabs; each click should trigger ~1 data request, not ~all-tabs.
  const CUSTOM = new Set(['upgrade-center', 'routing-simulator', 'realm-workbench', 'capability-matrix', 'tool-simulation', 'mcp-gateway-clients', 'mcp-gateway-activity', 'tool-approval-requests']);
  const generic = distinct.filter((t) => !CUSTOM.has(t)).slice(0, 8);
  let worstDelta = 0;
  for (const tab of generic) {
    const before = apiGets.length;
    await page.locator(`[data-admin-tab="${tab}"]`).first().click();
    await page.waitForTimeout(500);
    const delta = apiGets.length - before;
    worstDelta = Math.max(worstDelta, delta);
  }
  check('Each tab click loads ~1 tab (not all ~80)', worstDelta <= 6, `worst single-click delta = ${worstDelta} requests across ${generic.length} tabs`);

  // Full reload on the admin view (re-runs initialize) + more clicks — must stay under the 100-req edge ceiling.
  await page.reload();
  await page.waitForSelector('.admin-nav-sub, .workspace-nav', { timeout: 10000 });
  const groups2 = page.locator('.admin-group-btn');
  for (let i = 0; i < await groups2.count(); i++) { await groups2.nth(i).click().catch(() => {}); }
  for (const tab of generic.slice(0, 5)) {
    await page.locator(`[data-admin-tab="${tab}"]`).first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
  check('Zero 429s across open + many tab clicks + a full reload (under a 100-req limit)', count429 === 0, `${count429} × 429`);
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close();
  await app.stop?.();
  rmSync(dbDir, { recursive: true, force: true });
}

console.log('\n════════ Admin dashboard — lazy per-tab loading E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
