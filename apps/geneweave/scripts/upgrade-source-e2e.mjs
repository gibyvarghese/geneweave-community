// Self-contained full-stack E2E for the Upgrade Center's RELEASE-SOURCE configuration + version-compare panel.
//
// It stands up everything itself — no live GitHub, no external services:
//   1. mints an Ed25519 signing key and a signed release manifest (version 999.0.0, edition community),
//   2. serves a MOCK GitHub Releases API (releases/latest + the manifest asset) on a local port,
//   3. boots its own geneWeave on a free port (mock provider, temp DB),
//   4. drives headless Chromium through the real UI:
//        • the empty "no source configured" state,
//        • configuring a release source via the form (repo + edition + trusted PEM key) → saved + summarised,
//        • form validation (a bad repo shows an inline field error),
//        • pointing the saved source at the mock feed, then Check → the deployed-vs-available panel shows
//          "update available" + the Upgrade CTA, and the CTA runs Preview (layer cards render),
//   5. asserts zero CSP violations, then tears everything down.
//
// Run:  node scripts/upgrade-source-e2e.mjs   (from apps/geneweave, after `npm run build`)
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { createGeneWeave } from '../dist/index.js';
import { buildManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';

const EMAIL = 'src-admin@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 1. signing key + signed manifest ────────────────────────────────────────────
const key = generateAttestationSigningKey();
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '999.0.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [], code: { repoTag: 'v999.0.0', fileManifestDigest: `sha512-${createHash('sha512').update('src-e2e').digest('base64')}` } },
  artifacts: [],
}, key.privateKey);

// ── 2. mock GitHub Releases API ─────────────────────────────────────────────────
const mockPort = await freePort();
const mockBase = `http://127.0.0.1:${mockPort}`;
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/releases/latest')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v999.0.0', assets: [{ name: 'manifest.json', browser_download_url: `${mockBase}/dl/manifest.json` }] }));
  } else if (req.url.endsWith('/dl/manifest.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(manifest));
  } else { res.writeHead(404); res.end('{}'); }
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ── 3. boot geneWeave ───────────────────────────────────────────────────────────
process.env.PLAYWRIGHT_E2E = '1';
process.env.NODE_ENV = 'test';
process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';
const dbDir = mkdtempSync(join(tmpdir(), 'uc-src-db-'));
const dbPath = join(dbDir, 'app.db');
const port = await freePort();
const app = await createGeneWeave({
  port, host: '127.0.0.1', jwtSecret: 'uc-src-e2e-secret-0123456789ab',
  database: { type: 'sqlite', path: dbPath },
  providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model',
});
const B = `http://127.0.0.1:${port}`;

// ── 4. browser flow ─────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: B });
const page = await ctx.newPage();
const cspErrors = [];
page.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) cspErrors.push(m.text()); });

const openUpgradeCenter = async () => {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await page.waitForSelector('h2:has-text("Administration")', { timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible().catch(() => false))) { await page.locator('.admin-parent').click(); await sub.waitFor(); }
  const tab = page.locator('[data-admin-tab="upgrade-center"]').first();
  if (!(await tab.isVisible().catch(() => false))) await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  await tab.click();
  await page.waitForSelector('[data-upgrade-center]', { timeout: 8000 });
};

try {
  await page.goto(B);
  await page.request.post(`${B}/api/auth/register`, { data: { name: 'src', email: EMAIL, password: PW } });
  await page.request.post(`${B}/api/auth/login`, { data: { email: EMAIL, password: PW } });
  const csrf = (((await (await page.request.get(`${B}/api/auth/me`)).json())).csrfToken) ?? '';
  await page.request.post(`${B}/api/admin/upgrade/_test/promote-admin`, { headers: { 'x-csrf-token': csrf }, data: {} });
  await page.goto(B);
  await page.waitForSelector('.workspace-nav', { timeout: 15000 });
  await openUpgradeCenter();
  check('Upgrade Center renders', await page.locator('[data-upgrade-center]').count() > 0);

  // 4a. empty source state
  check('Shows "no source configured" before setup', await page.locator('[data-uc-source-empty]').count() === 1);

  // 4b. configure the source via the form
  await page.locator('[data-uc-source-edit]').click();
  await page.waitForSelector('[data-uc-source-form]', { timeout: 4000 });
  await page.locator('[data-uc-source-field="repo"]').fill('gibyvarghese/geneweave-community');
  await page.locator('[data-uc-source-field="edition"]').fill('community');
  await page.locator('[data-uc-source-field="trustedKeysPem"]').fill(publicPem);
  await page.locator('[data-uc-source-save]').click();
  await page.waitForTimeout(1000);
  check('Source saved + summarised', (await page.locator('[data-uc-source]').innerText()).includes('gibyvarghese/geneweave-community'));

  // 4c. form validation — a bad repo shows an inline field error
  await page.locator('[data-uc-source-edit]').click();
  await page.waitForSelector('[data-uc-source-form]');
  await page.locator('[data-uc-source-field="repo"]').fill('not-a-valid-repo');
  await page.locator('[data-uc-source-save]').click();
  await page.waitForTimeout(800);
  check('Invalid repo shows an inline field error', await page.locator('[data-uc-source-error="repo"]').count() === 1);
  await page.locator('[data-uc-source-cancel]').click();

  // 4d. point the saved source at the mock feed (apiBase is http→localhost, so set it below the UI validation
  //     layer, directly in the store the check reads — the UI form + its https validation are covered in 4b/4c).
  { const db = new Database(dbPath); db.prepare('UPDATE upgrade_source_config SET api_base = ?, repo = ? WHERE id = ?').run(mockBase, 'acme/app', 'default'); db.close(); }

  // 4e. Check → deployed-vs-available panel + Upgrade CTA
  await page.locator('[data-uc-step="check"]').click();
  await page.waitForTimeout(2000);
  const compare = page.locator('[data-uc-compare]');
  check('Version-compare panel shows update available', (await compare.getAttribute('data-uc-compare')) === 'update_available',
    await compare.innerText().catch(() => ''));
  check('Available version 999.0.0 shown', (await compare.innerText().catch(() => '')).includes('999.0.0'));
  check('Upgrade CTA rendered', await page.locator('[data-uc-upgrade]').count() === 1);

  // 4f. Upgrade CTA runs Preview → layer cards
  await page.locator('[data-uc-upgrade]').click();
  await page.waitForTimeout(1500);
  check('Upgrade CTA runs preview (layer cards render)', await page.locator('[data-uc-layers] .uc-layer-card').count() === 4);

  check('Zero CSP violations', cspErrors.length === 0, `${cspErrors.length}`);
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close();
  await app.stop?.();
  mock.close();
  rmSync(dbDir, { recursive: true, force: true });
}

console.log('\n════════ Upgrade Center — source config + version compare E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
