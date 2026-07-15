// Self-contained browser E2E for the FULL upgrade lifecycle — the whole "an upgrade exists → merge the code →
// apply it → now it's up to date, no upgrade offered" journey, driven through the real UI.
//
// It stands everything up itself (deterministic; single in-process DB connection, so there's no cross-process
// visibility/timing flakiness): a git fixture at v1.0.0 (installed) and v1.1.0 (release) with a local edit to
// src/greeting.ts, a mock GitHub feed serving the signed v1.1.0 manifest, and its own geneWeave on a free port.
//
//   1. an upgrade EXISTS — Check → "Deployed v1.0.0 → Available v1.1.0 · minor · update available" + Upgrade CTA;
//   2. MERGE the code — Scan → Load → Open merge on src/greeting.ts (you + the release both changed it) → resolve
//      in the in-app editor → Apply; the conflict clears;
//   3. UPGRADE — click Upgrade; the one-click run applies (preflight passes now the P1 is resolved) + reports it;
//   4. it IS upgraded — re-Check: status is "up to date" and the Upgrade CTA is GONE (anti-rollback: the engine
//      won't re-offer a release already accepted). NOTE: "Deployed" stays v1.0.0 — a running server only reports
//      the new version after an actual redeploy; the disappearance of the upgrade offer is the "you're current" signal.
//
// Run:  node scripts/upgrade-lifecycle-e2e.mjs   (from apps/geneweave, after `npm run build`)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer as netServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { createGeneWeave } from '../dist/index.js';
import { buildManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';

const EMAIL = 'lc-admin@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (n, ok, d = '') => { results.push(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const g = (root, args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// ── git fixture: v1.0.0 (installed) → v1.1.0 (release), with a local edit to greeting.ts ─────────
const fixture = mkdtempSync(join(tmpdir(), 'uc-lc-src-'));
mkdirSync(join(fixture, 'src'));
const write = (rel, txt) => writeFileSync(join(fixture, rel), txt);
g(fixture, ['init', '-q']); g(fixture, ['config', 'user.email', 'lc@local']); g(fixture, ['config', 'user.name', 'lc']);
write('src/greeting.ts', 'export function greeting(name: string): string {\n  return `Hello, ${name}`;\n}\n');
g(fixture, ['add', '-A']); g(fixture, ['commit', '-qm', 'v1.0.0']); g(fixture, ['tag', 'v1.0.0']);
write('src/greeting.ts', 'export function greeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n');
write('src/feature.ts', 'export const feature = 1;\n');
g(fixture, ['add', '-A']); g(fixture, ['commit', '-qm', 'v1.1.0']); g(fixture, ['tag', 'v1.1.0']);
g(fixture, ['checkout', '-q', 'v1.0.0']);
write('src/greeting.ts', 'export function greeting(name: string): string {\n  return `Hey there, ${name}`;\n}\n'); // LOCAL edit → conflict

// ── mock GitHub feed: the signed v1.1.0 manifest ─────────────────────────────────
const key = generateAttestationSigningKey();
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '1.1.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-06-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [], code: { repoTag: 'v1.1.0', fileManifestDigest: `sha512-${createHash('sha512').update('lc').digest('base64')}` } },
  artifacts: [],
}, key.privateKey);
const mockPort = await freePort();
const mockBase = `http://127.0.0.1:${mockPort}`;
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/releases/latest')) { res.writeHead(200); res.end(JSON.stringify({ tag_name: 'v1.1.0', assets: [{ name: 'manifest.json', browser_download_url: `${mockBase}/dl/manifest.json` }] })); }
  else if (req.url.endsWith('/dl/manifest.json')) { res.writeHead(200); res.end(JSON.stringify(manifest)); }
  else { res.writeHead(404); res.end('{}'); }
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ── boot geneWeave against the fixture ───────────────────────────────────────────
process.env.PLAYWRIGHT_E2E = '1'; process.env.NODE_ENV = 'test'; process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';
process.env.GENEWEAVE_SOURCE_ROOT = fixture;
process.env.GENEWEAVE_SOURCE_BASE_REF = 'v1.0.0';
const dbDir = mkdtempSync(join(tmpdir(), 'uc-lc-db-'));
const dbPath = join(dbDir, 'app.db');
const port = await freePort();
const app = await createGeneWeave({ port, host: '127.0.0.1', jwtSecret: 'lc-e2e-secret-0123456789ab', database: { type: 'sqlite', path: dbPath }, providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model' });
const B = `http://127.0.0.1:${port}`;
{ const db = new Database(dbPath); db.prepare(`INSERT INTO upgrade_source_config (id,repo,edition,asset_name,trusted_keys_pem,api_base,token_credential_id,auto_check,enabled,created_at,updated_at,updated_by) VALUES ('default',?,'community','manifest.json',?,?,NULL,0,1,datetime('now'),datetime('now'),NULL)`).run('acme/app', publicPem, mockBase); db.close(); }

const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: B })).newPage();
const compareAttr = () => page.locator('[data-uc-compare]').getAttribute('data-uc-compare').catch(() => null);
try {
  await page.goto(B);
  await page.request.post(`${B}/api/auth/register`, { data: { name: 'lc', email: EMAIL, password: PW } });
  await page.request.post(`${B}/api/auth/login`, { data: { email: EMAIL, password: PW } });
  const csrf = (((await (await page.request.get(`${B}/api/auth/me`)).json())).csrfToken) ?? '';
  await page.request.post(`${B}/api/admin/upgrade/_test/promote-admin`, { headers: { 'x-csrf-token': csrf }, data: {} });
  await page.goto(B); await page.waitForSelector('.workspace-nav', { timeout: 15000 });
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await page.waitForSelector('h2:has-text("Administration")', { timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible().catch(() => false))) { await page.locator('.admin-parent').click(); await sub.waitFor(); }
  const tab = page.locator('[data-admin-tab="upgrade-center"]').first();
  if (!(await tab.isVisible().catch(() => false))) await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  await tab.click();
  await page.waitForSelector('[data-upgrade-center]', { timeout: 8000 });

  // 1. upgrade exists
  await page.locator('[data-uc-step="check"]').click();
  await page.waitForTimeout(2000);
  check('An upgrade is available (update_available)', (await compareAttr()) === 'update_available', (await page.locator('[data-uc-compare]').innerText().catch(() => '')).replace(/\n/g, ' '));
  check('Available version is v1.1.0 (a minor bump)', (await page.locator('[data-uc-compare]').innerText().catch(() => '')).includes('1.1.0'));
  check('Upgrade button is shown', await page.locator('[data-uc-upgrade]').count() === 1);

  // 2. merge the code
  await page.locator('[data-uc-code-scan]').click(); await page.waitForTimeout(2500);
  await page.locator('[data-uc-code-load]').click(); await page.waitForTimeout(1200);
  check('src/greeting.ts is flagged as a conflict', await page.locator('[data-uc-code-item="src/greeting.ts"]').count() === 1);
  await page.locator('[data-uc-code-item="src/greeting.ts"] [data-uc-code-open]').click(); await page.waitForTimeout(2500);
  check('MergeView opens (two panes)', await page.locator('[data-uc-merge] .cm-editor').count() === 2);
  const right = page.locator('[data-uc-merge] .cm-editor').last().locator('.cm-content');
  await right.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('export function greeting(name: string): string {\n  return `Hey there, ${name}!`;\n}\n');
  await page.waitForTimeout(600);
  await page.locator('[data-uc-merge-apply]').click(); await page.waitForTimeout(1800);
  check('Code merged — greeting.ts cleared from the conflict list', await page.locator('[data-uc-code-item="src/greeting.ts"]').count() === 0);
  // Confirm no P1 remains before upgrading (the merge resolved the review row).
  { const db = new Database(dbPath); const openP1 = db.prepare("SELECT COUNT(*) c FROM upgrade_details WHERE priority='P1' AND resolution IS NULL").get().c; db.close(); check('No unresolved P1 remains after the merge', Number(openP1) === 0, `${openP1} open P1`); }

  // 3. upgrade
  await page.locator('[data-uc-upgrade]').click(); await page.waitForTimeout(2500);
  const runText = (await page.locator('[data-uc-run]').innerText().catch(() => '')).replace(/\n/g, ' ');
  check('Upgrade ran (not blocked by preflight)', await page.locator('[data-uc-run="ran"]').count() === 1, runText);
  check('Outcome references v1.1.0', runText.includes('1.1.0'));

  // 4. it is upgraded — no upgrade offered any more
  await page.locator('[data-uc-step="check"]').click(); await page.waitForTimeout(2000);
  check('Re-check shows "up to date"', (await compareAttr()) === 'up_to_date', String(await compareAttr()));
  check('The Upgrade button is GONE (nothing left to upgrade)', await page.locator('[data-uc-upgrade]').count() === 0);
  check('"update available" is no longer shown', !(await page.locator('[data-uc-compare]').innerText().catch(() => '')).toLowerCase().includes('update available'));
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close(); await app.stop?.(); mock.close();
  for (const d of [fixture, dbDir]) rmSync(d, { recursive: true, force: true });
}

console.log('\n════════ Upgrade Center — full lifecycle (hermetic) ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
