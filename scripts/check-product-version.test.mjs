// check-product-version.test.mjs — tests for the product-version guardrail.
//
// Run with:  node --test scripts/check-product-version.test.mjs
//
// These tests exercise the guard's pure logic with INJECTED inputs (version, docs, peer config, and
// an injected fetch), so they are deterministic and network-free, and the SAME file runs unchanged in
// both editions (community sets PEER=null, private sets PEER=community — the tests pass `peer`/
// `peerVersion` explicitly and never depend on the module's per-repo constants).
//
// The classic (4) high-concurrency and (5) served-endpoint-authz dimensions do not apply: this is a
// build-time CLI guard, not a runtime service. In their place we cover volume/stress and ReDoS-safety
// of the parser, plus determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSemver,
  fabricFor,
  topChangelogVersion,
  currentReleaseSection,
  checkConsistency,
  fetchPeerVersion,
  runGuard,
  FABRICS,
} from './check-product-version.mjs';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const goodVersioning = `# geneWeave Versioning
## Current release
| Version | Codename | Editions |
| **1.0.0** | Aertex | community + private |
## Related
other stuff mentioning 2.0.0 Batiste as an example
`;
const goodChangelog = `# Changelog
Based on Keep a Changelog + SemVer.
## [Unreleased]
## [1.0.0] — Aertex
- first GA
`;

// ── (1) Positive / happy path ───────────────────────────────────────────────────────────────
test('parseSemver accepts plain x.y.z', () => {
  assert.deepEqual(parseSemver('1.0.0'), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parseSemver(' 12.3.45 '), { major: 12, minor: 3, patch: 45 });
});

test('fabricFor maps majors to codenames', () => {
  assert.equal(fabricFor(1), 'Aertex');
  assert.equal(fabricFor(2), 'Batiste');
  assert.equal(fabricFor(FABRICS.length), 'Zephyr');
});

test('topChangelogVersion returns the newest version, skipping Unreleased', () => {
  assert.equal(topChangelogVersion(goodChangelog), '1.0.0');
  assert.equal(topChangelogVersion('## 2.3.4\n## 2.0.0'), '2.3.4'); // also accepts un-bracketed
});

test('currentReleaseSection extracts the section body', () => {
  const body = currentReleaseSection(goodVersioning);
  assert.match(body, /1\.0\.0/);
  assert.match(body, /Aertex/);
  assert.doesNotMatch(body, /Related/); // stops at the next heading
});

test('checkConsistency passes when version + docs agree', () => {
  assert.deepEqual(checkConsistency('1.0.0', goodVersioning, goodChangelog), []);
});

test('runGuard (self-only, peer=null) passes on consistent inputs', async () => {
  const r = await runGuard({ version: '1.0.0', versioningMd: goodVersioning, changelogMd: goodChangelog, peer: null });
  assert.deepEqual(r.problems, []);
  assert.equal(r.codename, 'Aertex');
  assert.equal(r.peerVersion, null);
});

test('runGuard (lockstep) passes when peer version matches', async () => {
  const r = await runGuard({
    version: '1.0.0', versioningMd: goodVersioning, changelogMd: goodChangelog,
    peer: { edition: 'community', url: 'x' }, peerVersion: '1.0.0',
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.peerVersion, '1.0.0');
});

// ── (2) Negative / boundaries ───────────────────────────────────────────────────────────────
test('parseSemver rejects non-x.y.z', () => {
  for (const bad of ['1.0', '1.0.0.0', 'v1.0.0', '1.0.0-rc.1', '1.0.0+build', 'abc', '', null, undefined]) {
    assert.equal(parseSemver(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('fabricFor returns null beyond the named majors', () => {
  assert.equal(fabricFor(FABRICS.length + 1), null);
  assert.equal(fabricFor(0), null);
});

test('checkConsistency flags an invalid product version', () => {
  const p = checkConsistency('1.0', goodVersioning, goodChangelog);
  assert.equal(p.length, 1);
  assert.match(p[0], /not valid SemVer/);
});

test('checkConsistency flags a major with no codename', () => {
  const bigMajor = `${FABRICS.length + 1}.0.0`;
  const p = checkConsistency(bigMajor, goodVersioning, goodChangelog);
  assert.ok(p.some((x) => /no fabric codename/.test(x)));
});

test('checkConsistency flags VERSIONING.md that does not name the version', () => {
  const stale = goodVersioning.replace('1.0.0', '9.9.9');
  const p = checkConsistency('1.0.0', stale, goodChangelog);
  assert.ok(p.some((x) => /Current release" does not name product version 1\.0\.0/.test(x)));
});

test('checkConsistency flags a missing Current release section', () => {
  const p = checkConsistency('1.0.0', '# no current release here', goodChangelog);
  assert.ok(p.some((x) => /no "## Current release" section/.test(x)));
});

test('checkConsistency flags a CHANGELOG whose newest version differs', () => {
  const cl = goodChangelog.replace('1.0.0', '1.1.0');
  const p = checkConsistency('1.0.0', goodVersioning, cl);
  assert.ok(p.some((x) => /newest version 1\.1\.0 != product version 1\.0\.0/.test(x)));
});

test('checkConsistency flags a CHANGELOG with no versioned heading', () => {
  const p = checkConsistency('1.0.0', goodVersioning, '# Changelog\n## [Unreleased]\n');
  assert.ok(p.some((x) => /no versioned/.test(x)));
});

test('runGuard flags a lockstep divergence', async () => {
  const r = await runGuard({
    version: '1.0.0', versioningMd: goodVersioning, changelogMd: goodChangelog,
    peer: { edition: 'community', url: 'x' }, peerVersion: '1.1.0',
  });
  assert.ok(r.problems.some((x) => /lockstep violated/.test(x)));
});

// ── fetchPeerVersion behaviour (network injected) ───────────────────────────────────────────
test('fetchPeerVersion returns null when there is no peer', async () => {
  assert.equal(await fetchPeerVersion(null), null);
});

test('fetchPeerVersion honours the PEER_PRODUCT_VERSION override', async () => {
  const v = await fetchPeerVersion({ edition: 'community', url: 'x' }, { env: { PEER_PRODUCT_VERSION: ' 2.0.0 ' } });
  assert.equal(v, '2.0.0');
});

test('fetchPeerVersion reads version from a successful fetch', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) });
  const v = await fetchPeerVersion({ edition: 'community', url: 'x' }, { fetchImpl, env: {} });
  assert.equal(v, '1.2.3');
});

test('fetchPeerVersion retries then throws on persistent failure', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; };
  await assert.rejects(
    () => fetchPeerVersion({ edition: 'community', url: 'x' }, { fetchImpl, env: {}, retries: 3 }),
    /could not read community product version/,
  );
  assert.equal(calls, 3, 'should have retried exactly `retries` times');
});

test('fetchPeerVersion retries on a thrown network error', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('ECONNRESET'); };
  await assert.rejects(() => fetchPeerVersion({ edition: 'community', url: 'x' }, { fetchImpl, env: {}, retries: 2 }));
  assert.equal(calls, 2);
});

// ── (3) Stress / volume  +  ReDoS safety  +  determinism ────────────────────────────────────
test('parser is ReDoS-safe on a pathological input', () => {
  const started = Date.now();
  assert.equal(parseSemver('1'.repeat(200000) + '.0.0-' + 'a'.repeat(200000)), null);
  assert.ok(Date.now() - started < 1000, 'linear regex must not blow up on long input');
});

test('checkConsistency is deterministic and fast over many versions', () => {
  const N = 20000;
  let firstOutput = null;
  const started = Date.now();
  for (let i = 0; i < N; i++) {
    const out = checkConsistency('1.0.0', goodVersioning, goodChangelog);
    if (i === 0) firstOutput = JSON.stringify(out);
    else assert.equal(JSON.stringify(out), firstOutput); // same input ⇒ identical output
  }
  const ms = Date.now() - started;
  assert.equal(firstOutput, '[]');
  assert.ok(ms < 5000, `expected <5s for ${N} runs, took ${ms}ms`);
  console.log(`  stress: ${N} checks in ${ms}ms (${(ms / N).toFixed(4)} ms/check)`);
});
