// Self-contained full-stack E2E for the L2 REMOTE code scan — detecting code changes by fetching the release
// trees straight from GitHub, with NO local git checkout.
//
//   1. builds three trees: BASE (installed v1.0.0), REMOTE (target v2.0.0), and a live INSTALL dir that is a
//      plain directory (NOT a git repo) with an operator edit → src/greeting.ts diverges on both sides,
//   2. serves a MOCK GitHub: releases/latest + the signed manifest (fileManifestDigest = the REMOTE tree's real
//      baseline digest) + tarballs at v1.0.0 and v2.0.0,
//   3. boots geneWeave with GENEWEAVE_SOURCE_ROOT = the (non-git) install dir + the source pre-seeded at the mock,
//   4. drives Chromium: Check (accepts v2.0.0) → Code → "Scan release" (local git unavailable → falls back to the
//      remote fetch, integrity-verified) → Load → the operator-edited file appears as a conflict,
//   5. tears everything down.
//
// Run:  node scripts/upgrade-remote-scan-e2e.mjs   (from apps/geneweave, after `npm run build`)
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer as netServer } from 'node:net';
import { create as tarCreate } from 'tar';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { createGeneWeave } from '../dist/index.js';
import { buildManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { generateSourceBaselines } from '../dist/source-baselines.js';

const EMAIL = 'rmt-admin@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (n, ok, d = '') => { results.push(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 1. trees ────────────────────────────────────────────────────────────────────
const mkTree = (files) => { const d = mkdtempSync(join(tmpdir(), 'uc-rmt-')); for (const [p, c] of Object.entries(files)) { const a = join(d, 'pkg', p); mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, c); } return d; };
const BASE = { 'src/greeting.ts': 'export const g = "WORLD";\n', 'src/stable.ts': 'export const s = true;\n' };
const REMOTE = { 'src/greeting.ts': 'export const g = "UNIVERSE";\n', 'src/stable.ts': 'export const s = true;\n', 'src/feature.ts': 'export const f = 1;\n' };
const baseDir = mkTree(BASE), remoteDir = mkTree(REMOTE);
// live install (LOCAL) — a plain dir, not git; operator edited greeting.ts to EARTH.
const installRoot = mkdtempSync(join(tmpdir(), 'uc-install-'));
for (const [p, c] of Object.entries({ 'src/greeting.ts': 'export const g = "EARTH";\n', 'src/stable.ts': 'export const s = true;\n' })) { const a = join(installRoot, p); mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, c); }
const remoteDigest = generateSourceBaselines(join(remoteDir, 'pkg')).digest; // the manifest's fileManifestDigest

const tarball = async (dir) => { const chunks = []; for await (const c of tarCreate({ gzip: true, cwd: dir }, ['pkg'])) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
const [baseTar, remoteTar] = [await tarball(baseDir), await tarball(remoteDir)];

// ── 2. signed manifest + mock GitHub ────────────────────────────────────────────
const key = generateAttestationSigningKey();
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '2.0.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [], code: { repoTag: 'v2.0.0', fileManifestDigest: remoteDigest } },
  artifacts: [],
}, key.privateKey);
const mockPort = await freePort();
const mockBase = `http://127.0.0.1:${mockPort}`;
const mock = http.createServer((req, res) => {
  const u = req.url;
  if (u.endsWith('/releases/latest')) { res.writeHead(200); res.end(JSON.stringify({ tag_name: 'v2.0.0', assets: [{ name: 'manifest.json', browser_download_url: `${mockBase}/dl/manifest.json` }] })); }
  else if (u.endsWith('/dl/manifest.json')) { res.writeHead(200); res.end(JSON.stringify(manifest)); }
  else if (u.endsWith('/tarball/v1.0.0')) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(baseTar); }
  else if (u.endsWith('/tarball/v2.0.0')) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(remoteTar); }
  else { res.writeHead(404); res.end('{}'); }
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ── 3. boot geneWeave (install root is the non-git LOCAL tree) ───────────────────
process.env.PLAYWRIGHT_E2E = '1'; process.env.NODE_ENV = 'test'; process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';
process.env.GENEWEAVE_SOURCE_ROOT = installRoot;
const dbDir = mkdtempSync(join(tmpdir(), 'uc-rmt-db-'));
const dbPath = join(dbDir, 'app.db');
const port = await freePort();
const app = await createGeneWeave({ port, host: '127.0.0.1', jwtSecret: 'uc-rmt-e2e-secret-0123456789', database: { type: 'sqlite', path: dbPath }, providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model' });
const B = `http://127.0.0.1:${port}`;
{ const db = new Database(dbPath); db.prepare(`INSERT INTO upgrade_source_config (id,repo,edition,asset_name,trusted_keys_pem,api_base,token_credential_id,auto_check,enabled,created_at,updated_at,updated_by) VALUES ('default',?,'community','manifest.json',?,?,NULL,0,1,datetime('now'),datetime('now'),NULL)`).run('acme/app', publicPem, mockBase); db.close(); }

// ── 4. browser ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: B })).newPage();
try {
  await page.goto(B);
  await page.request.post(`${B}/api/auth/register`, { data: { name: 'r', email: EMAIL, password: PW } });
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

  // Check → accepts the signed v2.0.0 manifest (records repoTag + fileManifestDigest the remote scan needs).
  await page.locator('[data-uc-step="check"]').click();
  await page.waitForTimeout(2000);
  check('Check accepts the signed release', (await page.locator('[data-uc-compare]').getAttribute('data-uc-compare')) === 'update_available');

  // Scan release → no local git → falls back to the integrity-verified remote fetch → records the conflict.
  await page.locator('[data-uc-code-scan]').click();
  await page.waitForTimeout(3000);
  await page.locator('[data-uc-code-load]').click();
  await page.waitForTimeout(1200);
  const err = await page.locator('[data-uc-error]').innerText().catch(() => '');
  check('No scan error banner', err === '', err);
  check('Remote scan detected the operator-edited file as a conflict', await page.locator('[data-uc-code-item="src/greeting.ts"]').count() === 1,
    `${await page.locator('[data-uc-code-item]').count()} conflict file(s)`);
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close(); await app.stop?.(); mock.close();
  for (const d of [baseDir, remoteDir, installRoot, dbDir]) rmSync(d, { recursive: true, force: true });
}

console.log('\n════════ Upgrade Center — remote code scan (no local git) E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
