// build-release-manifest-e2e.mjs — hermetic, in-process end-to-end proof of the release publisher.
//
// No live GitHub, no browser, no child process. In ONE process it:
//   1. builds a temp source tree and serves it as a gzipped tarball from a MOCK GitHub tarball endpoint,
//   2. computes fileManifestDigest via the REAL `fetchTreeBaseline` (the same code + tarball a client uses),
//   3. assembles + signs a manifest with the publisher's OWN functions (buildReleaseBody + signAndSelfVerify)
//      against an ephemeral key whose public half is the "committed" trust key,
//   4. proves the manifest's digest EQUALS a client's independent re-fetch (the TUF integrity contract),
//   5. proves the real UpdateChecker ACCEPTS the signed manifest and REJECTS a tampered copy.
//
// Run:  node scripts/build-release-manifest-e2e.mjs   (from apps/geneweave, after `npm run build`)
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer as netServer } from 'node:net';
import { create as tarCreate } from 'tar';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createUpdateChecker, createEd25519Verifier } from '@weaveintel/upgrade';
import { fetchTreeBaseline } from '../dist/code-remote-fetch.js';
import { buildReleaseBody, signAndSelfVerify, EDITION_DEFAULT } from './build-release-manifest.mjs';

let pass = 0, fail = 0; const results = [];
const check = (n, ok, d = '') => { results.push(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 1. temp source tree + mock GitHub tarball ────────────────────────────────────
const mkTree = (files) => { const d = mkdtempSync(join(tmpdir(), 'brm-tree-')); for (const [p, c] of Object.entries(files)) { const a = join(d, 'pkg', p); mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, c); } return d; };
const treeDir = mkTree({ 'src/index.ts': 'export const v = 1;\n', 'README.md': '# app\n' });
const tarball = async (dir) => { const chunks = []; for await (const c of tarCreate({ gzip: true, cwd: dir }, ['pkg'])) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
const tar = await tarball(treeDir);

const REPO = 'acme/app', TAG = 'v1.0.0';
const mockPort = await freePort();
const mockBase = `http://127.0.0.1:${mockPort}`;
const mock = http.createServer((req, res) => {
  if (req.url.endsWith(`/repos/${REPO}/tarball/${TAG}`)) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(tar); }
  else { res.writeHead(404); res.end('{}'); }
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

const key = generateAttestationSigningKey();
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();

try {
  // ── 2. compute the digest the way a client does (real fetchTreeBaseline over the mock tarball) ──
  const source = { repo: REPO, apiBase: mockBase };
  const fileManifestDigest = (await fetchTreeBaseline(source, TAG)).digest;
  check('fetchTreeBaseline computed a source-tree digest', /^sha512-/.test(fileManifestDigest), fileManifestDigest.slice(0, 20) + '…');

  // ── 3. assemble + sign with the publisher's own functions ──────────────────────
  const body = buildReleaseBody({ name: '@weaveintel/geneweave-api', version: '1.0.0', edition: EDITION_DEFAULT, tag: TAG, fileManifestDigest, publishedAt: new Date('2026-01-01').toISOString(), node: '>=20' });
  const { manifest, fingerprint } = signAndSelfVerify(body, key.privateKey, [publicPem]);
  check('publisher signed + self-verified the manifest', !!manifest.signature?.value && !!fingerprint);
  check('code layer records the tag + digest', manifest.layers.code.repoTag === TAG && manifest.layers.code.fileManifestDigest === fileManifestDigest);
  check('codename derived from the major', manifest.codename === 'Aertex', manifest.codename);

  // ── 4. integrity: an independent client re-fetch yields the SAME digest ─────────
  const clientDigest = (await fetchTreeBaseline(source, TAG)).digest;
  check('client re-fetch digest matches the manifest (TUF integrity)', clientDigest === manifest.layers.code.fileManifestDigest);

  // ── 5. the real UpdateChecker accepts it; a tampered copy is rejected ───────────
  const verifier = createEd25519Verifier([publicPem]);
  const accept = await createUpdateChecker({ source: { latest: async () => manifest }, verifier, edition: EDITION_DEFAULT, currentVersion: '0.9.0' }).check();
  check('UpdateChecker accepts the signed release', accept.status === 'update_available', accept.status);
  const reject = await createUpdateChecker({ source: { latest: async () => ({ ...manifest, version: '9.9.9' }) }, verifier, edition: EDITION_DEFAULT, currentVersion: '0.9.0' }).check();
  check('UpdateChecker rejects a tampered manifest as bad_signature', reject.status === 'rejected' && reject.reason === 'bad_signature', reject.reason);
} catch (err) {
  check(`FATAL: ${err.message}`, false);
} finally {
  mock.close();
  rmSync(treeDir, { recursive: true, force: true });
}

console.log('\n════════ build-release-manifest — hermetic in-process E2E ════════');
for (const r of results) console.log('  ' + r);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
