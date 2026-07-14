// Self-contained full-stack E2E for the Upgrade Center's in-app L2 code merge.
//
// Unlike src/upgrade-center.e2e.ts (which runs against the shared managed server that
// has no source git repo, so the merge view can only reach its git_required fallback),
// this harness stands up EVERYTHING itself and exercises the REAL @codemirror/merge
// editor end to end:
//   1. builds a throwaway git fixture (v-base WORLD → v-target UNIVERSE, working tree EARTH),
//   2. boots its own geneWeave server on a free port with GENEWEAVE_SOURCE_ROOT pointed at it,
//   3. injects an accepted release manifest (repoTag=v-target) so a three-way conflict is real,
//   4. drives headless Chromium through: login → Upgrade Center → scan → load → open the
//      MergeView → resolve → Apply, asserting the live count/Apply-gate, CSP cleanliness,
//      and that the resolution is written back to the working tree,
//   5. tears the server + temp files down.
//
// Run:  node scripts/upgrade-center-e2e.mjs      (from apps/geneweave, after `npm run build`)
// Exits non-zero on any failed assertion. No external services; uses the mock provider.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { createGeneWeave } from '../dist/index.js';
import { buildManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';

const EMAIL = 'e2e-admin@local.test', PW = 'Str0ng!Pass99';
let pass = 0, fail = 0; const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const g = (root, args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 1. throwaway git fixture ────────────────────────────────────────────────────
const fixture = mkdtempSync(join(tmpdir(), 'uc-e2e-src-'));
const dbPath = join(mkdtempSync(join(tmpdir(), 'uc-e2e-db-')), 'app.db');
const write = (rel, txt) => writeFileSync(join(fixture, rel), txt);
g(fixture, ['init', '-q']);
g(fixture, ['config', 'user.email', 'e2e@local']); g(fixture, ['config', 'user.name', 'e2e']);
mkdirSync(join(fixture, 'src'));
write('src/greeting.ts', 'export function greeting() {\n  return "Hello, WORLD";\n}\n');
write('src/stable.ts', 'export const stable = true;\n');
g(fixture, ['add', '-A']); g(fixture, ['commit', '-qm', 'base']); g(fixture, ['tag', 'v-base']);
write('src/greeting.ts', 'export function greeting() {\n  return "Hello, UNIVERSE";\n}\n');
write('src/feature.ts', 'export const feature = "shiny";\n');
g(fixture, ['add', '-A']); g(fixture, ['commit', '-qm', 'release']); g(fixture, ['tag', 'v-target']);
g(fixture, ['checkout', '-q', 'v-base']);
write('src/greeting.ts', 'export function greeting() {\n  return "Hello, EARTH";\n}\n'); // LOCAL edit → real 3-way conflict

// ── 2. boot our own server ──────────────────────────────────────────────────────
process.env.GENEWEAVE_SOURCE_ROOT = fixture;
process.env.GENEWEAVE_SOURCE_BASE_REF = 'v-base';
process.env.PLAYWRIGHT_E2E = '1';                       // enables the _test/promote-admin route
process.env.NODE_ENV = 'test';                          // auto-verifies email on register (so login isn't gated)
process.env.GENEWEAVE_LOGIN_MAX_BACKOFF_MS = '0';
const port = await freePort();
const app = await createGeneWeave({
  port, host: '127.0.0.1', jwtSecret: 'uc-e2e-secret-0123456789abcdef',
  database: { type: 'sqlite', path: dbPath },
  providers: { mock: { apiKey: 'mock' } }, defaultProvider: 'mock', defaultModel: 'mock-model',
});
const B = `http://127.0.0.1:${port}`;

// ── 3. inject an accepted release manifest (repoTag=v-target) ────────────────────
const key = generateAttestationSigningKey();
const manifest = buildManifest({
  manifestVersion: 1, name: '@geneweave/app', version: '2.0.0', channel: 'stable', edition: 'community',
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [], code: { repoTag: 'v-target', fileManifestDigest: 'sha512-e2e' } },
  artifacts: [],
}, key.privateKey);
{
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO upgrade_releases (id, name, version, edition, channel, published_at, key_fingerprint, outcome, accepted, manifest_json, checked_at)
    VALUES (?,?,?,?,?,?,?,?,1,?, datetime('now'))`).run(
    'rel-e2e', '@geneweave/app', '2.0.0', 'community', 'stable', '2026-01-01',
    manifest.signature.keyFingerprint, 'update_available', JSON.stringify(manifest));
  db.close();
}

// ── 4. browser flow ─────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: B });
const page = await ctx.newPage();
const cspErrors = [], pageErrors = [];
page.on('console', m => { if (/Content Security Policy|violates the following/i.test(m.text())) cspErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(e.message));

try {
  // register + promote to platform_admin (fresh temp DB has no users)
  await page.goto(B);
  const reg = await page.request.post(`${B}/api/auth/register`, { data: { name: 'e2e', email: EMAIL, password: PW } });
  const login = await page.request.post(`${B}/api/auth/login`, { data: { email: EMAIL, password: PW } });
  if (!login.ok()) console.log(`  [diag] register ${reg.status()} · login ${login.status()} ${await login.text()}`);
  const meCsrf = async () => (((await (await page.request.get(`${B}/api/auth/me`)).json())).csrfToken) ?? '';
  await page.request.post(`${B}/api/admin/upgrade/_test/promote-admin`, { headers: { 'x-csrf-token': await meCsrf() }, data: {} });
  await page.goto(B);
  await page.waitForSelector('.workspace-nav', { timeout: 15000 });
  check('Boot + login + promote to platform_admin', true);

  // open Upgrade Center
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await page.waitForSelector('h2:has-text("Administration")', { timeout: 8000 });
  const sub = page.locator('.admin-nav-sub');
  if (!(await sub.isVisible().catch(() => false))) { await page.locator('.admin-parent').click(); await sub.waitFor(); }
  let tab = page.locator('[data-admin-tab="upgrade-center"]').first();
  if (!(await tab.isVisible().catch(() => false))) await page.locator('.admin-group-btn', { hasText: 'Governance' }).click();
  await tab.click();
  await page.waitForSelector('[data-upgrade-center]', { timeout: 8000 });
  check('Upgrade Center renders', await page.locator('[data-upgrade-center] h2:has-text("Upgrade Center")').count() > 0);

  // scan the accepted release → records the real conflict
  await page.locator('[data-uc-code-scan]').click();
  await page.waitForTimeout(2500);
  check('Scan release records conflicts (not git_required)',
    !(await page.locator('[data-uc-error]').innerText().catch(() => '')).includes('unavailable'));

  await page.locator('[data-uc-code-load]').click();
  await page.waitForTimeout(1000);
  check('greeting.ts listed as a conflict', await page.locator('[data-uc-code-item="src/greeting.ts"]').count() === 1);

  // open the REAL MergeView (no git_required this time)
  await page.locator('[data-uc-code-item="src/greeting.ts"] [data-uc-code-open]').click();
  await page.waitForTimeout(2500);
  check('MergeView mounts two panes (real editor, not git-required note)',
    await page.locator('[data-uc-merge] .cm-editor').count() === 2 && await page.locator('[data-uc-merge-git]').count() === 0);
  check('Per-chunk accept-incoming controls present', await page.locator('[data-uc-merge] .cm-merge-revert').count() >= 1);
  check('Apply gated while a conflict remains', await page.locator('[data-uc-merge-apply]').isDisabled(),
    await page.locator('[data-uc-merge-count]').innerText());

  // resolve through the editable pane, watch the gate open
  const right = page.locator('[data-uc-merge] .cm-editor').last().locator('.cm-content');
  await right.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('export function greeting() {\n  return "Hello, UNIVERSE";\n}\n');
  await page.waitForTimeout(600);
  check('Live count clears + Apply enables', !(await page.locator('[data-uc-merge-apply]').isDisabled()),
    await page.locator('[data-uc-merge-count]').innerText());

  await page.locator('[data-uc-merge-apply]').click();
  await page.waitForTimeout(1800);
  check('Apply closes the panel + removes the file from the list',
    await page.locator('[data-uc-merge]').count() === 0 && await page.locator('[data-uc-code-item="src/greeting.ts"]').count() === 0);
  const onDisk = execFileSync('cat', [join(fixture, 'src/greeting.ts')]).toString();
  check('Resolution written to the working tree', onDisk.includes('UNIVERSE') && !onDisk.includes('<<<<<<<'));

  check('Zero CSP violations across the run', cspErrors.length === 0, `${cspErrors.length}`);
  check('Zero uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  await browser.close();
  await app.stop?.();
  rmSync(fixture, { recursive: true, force: true });
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
}

console.log('\n════════ Upgrade Center — self-contained full-stack E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
