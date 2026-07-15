// build-release-manifest.test.mjs — tests for the release-manifest publisher.
//
// Run with:  node --test scripts/build-release-manifest.test.mjs   (from apps/geneweave)
//
// Network-free and app-build-free: the publisher's pure logic (assemble/lint/sign/self-verify) is exercised with
// ephemeral Ed25519 keys and a synthetic SRI digest, and the FULL discovery pipeline is driven through the real
// `@weaveintel/upgrade` `createUpdateChecker` over an in-memory source — so a signed manifest is proven to be
// accepted (or distinctly rejected: tamper / untrusted key / wrong edition / downgrade / expired) exactly as a
// running instance would decide.
//
// The classic dimensions (4) high-concurrency and (5) security are covered as: many parallel sign+verify with
// latency percentiles + a no-cross-trust-leakage check under volume; secret-never-serialized + schema bounds +
// tamper detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildReleaseBody, checkReleaseInputs, readTrustedPublicKeys, signAndSelfVerify, EDITION_DEFAULT,
} from './build-release-manifest.mjs';
import { createUpdateChecker, createEd25519Verifier, parseManifest, lintManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey, fingerprintEd25519PublicKey } from '@weaveintel/encryption';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const key = generateAttestationSigningKey();
const otherKey = generateAttestationSigningKey();
const pubPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPubPem = otherKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
/** A well-formed SRI digest (the manifest treats it as an opaque string; real matching is E2E-tested). */
const digest = (seed = 'tree') => `sha512-${createHash('sha512').update(seed).digest('base64')}`;

/** A ready-to-sign body for `version`/`edition`. */
const bodyFor = (version = '1.0.0', edition = 'community', extra = {}) => buildReleaseBody({
  name: '@weaveintel/geneweave-api', version, edition, tag: `v${version}`,
  fileManifestDigest: digest(), publishedAt: '2026-01-01T00:00:00.000Z', node: '>=20', ...extra,
});

/** An in-memory ReleaseSource serving `manifest` (round-tripped through JSON+schema like the real fetch). */
const sourceOf = (manifest) => ({ latest: async () => parseManifest(JSON.parse(JSON.stringify(manifest))) });

// ── (1) Positive / happy path ───────────────────────────────────────────────────────────────
test('buildReleaseBody assembles a valid code-layer body with the right codename', () => {
  const b = bodyFor('1.2.3');
  assert.equal(b.manifestVersion, 1);
  assert.equal(b.version, '1.2.3');
  assert.equal(b.codename, 'Aertex'); // major 1
  assert.equal(b.edition, 'community');
  assert.equal(b.channel, 'stable');
  assert.equal(b.requires.node, '>=20');
  assert.equal(b.layers.code.repoTag, 'v1.2.3');
  assert.match(b.layers.code.fileManifestDigest, /^sha512-/);
  assert.deepEqual(b.layers.packages, []);
});

test('codename tracks the major (2.0.0 → Batiste)', () => {
  assert.equal(bodyFor('2.0.0').codename, 'Batiste');
});

test('signAndSelfVerify signs + verifies against the committed key, returns the fingerprint', () => {
  const { manifest, fingerprint } = signAndSelfVerify(bodyFor(), key.privateKey, [pubPem]);
  assert.equal(manifest.signature.alg, 'Ed25519');
  assert.equal(fingerprint, fingerprintEd25519PublicKey(key.publicKey));
  // round-trips through the schema unchanged
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest))), manifest);
});

test('FULL PIPELINE: a built+signed release is accepted by the real UpdateChecker', async () => {
  const { manifest } = signAndSelfVerify(bodyFor('1.0.0'), key.privateKey, [pubPem]);
  const checker = createUpdateChecker({
    source: sourceOf(manifest), verifier: createEd25519Verifier([pubPem]),
    edition: 'community', currentVersion: '0.9.0',
  });
  assert.equal((await checker.check()).status, 'update_available');

  const same = createUpdateChecker({
    source: sourceOf(manifest), verifier: createEd25519Verifier([pubPem]),
    edition: 'community', currentVersion: '1.0.0',
  });
  assert.equal((await same.check()).status, 'up_to_date');
});

// ── (2) Negative / boundaries ───────────────────────────────────────────────────────────────
test('checkReleaseInputs flags tag/version/edition/digest problems', () => {
  assert.deepEqual(checkReleaseInputs({ version: '1.0.0', tag: 'v1.0.0', edition: 'community', fileManifestDigest: digest() }), []);
  const p = checkReleaseInputs({ version: '1.0', tag: 'v2.0.0', edition: '', fileManifestDigest: 'nope' });
  assert.ok(p.some((x) => /not plain SemVer/.test(x)));
  assert.ok(p.some((x) => /must equal "v1\.0"/.test(x)));
  assert.ok(p.some((x) => /edition is required/.test(x)));
  assert.ok(p.some((x) => /not an SRI hash/.test(x)));
});

test('signAndSelfVerify FAILS closed when no public key is committed', () => {
  assert.throws(() => signAndSelfVerify(bodyFor(), key.privateKey, []), /no committed public key/);
});

test('signAndSelfVerify FAILS when the signing key is not among the committed keys', () => {
  // signed by `key`, but only `otherKey` is trusted → cannot self-verify (wrong/rotated secret)
  assert.throws(() => signAndSelfVerify(bodyFor(), key.privateKey, [otherPubPem]), /does not verify against any committed public key/);
});

test('lint rejects an empty release note on a content entry', () => {
  const b = bodyFor('1.0.0', 'community', { content: [{ family: 'skills', logicalKey: 'k', remoteHash: 'sha256:x', releaseNote: '   ' }] });
  const r = lintManifest(b);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'empty_release_note'));
});

test('UpdateChecker: tamper → bad_signature', async () => {
  const { manifest } = signAndSelfVerify(bodyFor('1.0.0'), key.privateKey, [pubPem]);
  const tampered = { ...manifest, version: '9.9.9' }; // signature no longer covers the body
  const checker = createUpdateChecker({ source: sourceOf(tampered), verifier: createEd25519Verifier([pubPem]), edition: 'community', currentVersion: '0.1.0' });
  const r = await checker.check();
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'bad_signature');
});

test('UpdateChecker: untrusted key / wrong edition / downgrade / expired each reject distinctly', async () => {
  const { manifest } = signAndSelfVerify(bodyFor('1.0.0', 'community', { expiresAt: '2026-06-01T00:00:00.000Z' }), key.privateKey, [pubPem]);
  // Pin the clock BEFORE expiry for the non-expiry checks (else the real clock, past 2026-06-01, expires first).
  const preExpiry = () => new Date('2026-02-01T00:00:00.000Z');
  const base = { source: sourceOf(manifest), edition: 'community', currentVersion: '0.1.0', now: preExpiry };

  // untrusted key — verifier doesn't hold our key
  assert.equal((await createUpdateChecker({ ...base, verifier: createEd25519Verifier([otherPubPem]) }).check()).reason, 'untrusted_key');
  // wrong edition — instance is 'enterprise'
  assert.equal((await createUpdateChecker({ ...base, verifier: createEd25519Verifier([pubPem]), edition: 'enterprise' }).check()).reason, 'edition_mismatch');
  // downgrade — instance already at 2.0.0
  assert.equal((await createUpdateChecker({ ...base, verifier: createEd25519Verifier([pubPem]), currentVersion: '2.0.0' }).check()).reason, 'downgrade');
  // expired — clock past expiresAt
  assert.equal((await createUpdateChecker({ ...base, verifier: createEd25519Verifier([pubPem]), now: () => new Date('2026-07-01T00:00:00.000Z') }).check()).reason, 'expired');
});

// ── (3) Stress / volume + determinism ───────────────────────────────────────────────────────
test('signing is deterministic (Ed25519): identical body ⇒ identical signature', () => {
  const b = bodyFor('3.4.5');
  const a1 = signAndSelfVerify(b, key.privateKey, [pubPem]).manifest.signature.value;
  const a2 = signAndSelfVerify(b, key.privateKey, [pubPem]).manifest.signature.value;
  assert.equal(a1, a2);
});

test('handles a large content layer (5000 entries) and still verifies', () => {
  const content = Array.from({ length: 5000 }, (_, i) => ({ family: 'skills', logicalKey: `k${i}`, remoteHash: `sha256:${i}`, releaseNote: `note ${i}` }));
  const b = bodyFor('1.0.0', 'community', { content });
  assert.equal(lintManifest(b).ok, true);
  const { manifest } = signAndSelfVerify(b, key.privateKey, [pubPem]);
  assert.equal(manifest.layers.content.length, 5000);
});

// ── (4) Concurrency / load — parallel sign+verify with latency percentiles ──────────────────
for (const N of [1000, 10000]) {
  test(`concurrency: ${N} parallel sign+verify — all valid, zero failures, latency measured`, async () => {
    const verifier = createEd25519Verifier([pubPem]);
    const lat = new Array(N);
    const ops = Array.from({ length: N }, (_, i) => async () => {
      const t0 = process.hrtime.bigint();
      const { manifest } = signAndSelfVerify(bodyFor(`1.0.${i % 1000}`), key.privateKey, [pubPem]);
      const checker = createUpdateChecker({ source: sourceOf(manifest), verifier, edition: 'community', currentVersion: '0.0.1' });
      const ok = (await checker.check()).status === 'update_available';
      lat[i] = Number(process.hrtime.bigint() - t0) / 1e6; // ms
      return ok;
    });
    const started = Date.now();
    const results = await Promise.all(ops.map((op) => op()));
    const wall = Date.now() - started;
    const failures = results.filter((r) => !r).length;
    assert.equal(failures, 0, `${failures}/${N} failed`);
    lat.sort((a, b) => a - b);
    const pct = (p) => lat[Math.min(N - 1, Math.floor((p / 100) * N))].toFixed(3);
    console.log(`  ${N} ops in ${wall}ms — ${(N / (wall / 1000)).toFixed(0)} ops/s · p50=${pct(50)}ms p95=${pct(95)}ms p99=${pct(99)}ms`);
  });
}

test('no cross-trust leakage under volume: a verifier accepts only its own key across 2000 mixed manifests', async () => {
  const verifierA = createEd25519Verifier([pubPem]); // trusts only `key`
  let acceptedFromA = 0, rejectedFromB = 0;
  await Promise.all(Array.from({ length: 2000 }, (_, i) => (async () => {
    const mine = i % 2 === 0;
    const signer = mine ? key.privateKey : otherKey.privateKey;
    // sign directly (bypass self-verify, which would reject the otherKey manifests by design)
    const { buildManifest } = await import('@weaveintel/upgrade');
    const manifest = buildManifest(bodyFor(`1.0.${i}`), signer);
    const r = await createUpdateChecker({ source: sourceOf(manifest), verifier: verifierA, edition: 'community', currentVersion: '0.0.1' }).check();
    if (mine) { if (r.status === 'update_available') acceptedFromA++; }
    else { if (r.status === 'rejected' && r.reason === 'untrusted_key') rejectedFromB++; }
  })()));
  assert.equal(acceptedFromA, 1000, 'every manifest signed by the trusted key is accepted');
  assert.equal(rejectedFromB, 1000, 'every manifest signed by an untrusted key is rejected untrusted_key');
});

// ── (5) Security — secret handling, schema bounds, injection ────────────────────────────────
test('the serialized manifest never contains private-key material', () => {
  const { manifest } = signAndSelfVerify(bodyFor(), key.privateKey, [pubPem]);
  const json = JSON.stringify(manifest);
  assert.doesNotMatch(json, /PRIVATE KEY/);
  assert.doesNotMatch(json, /BEGIN (EC |RSA )?PRIVATE/);
});

test('over-long fields are bounded by the schema (buildManifest throws inside signAndSelfVerify)', () => {
  const b = buildReleaseBody({ name: 'a'.repeat(5000), version: '1.0.0', edition: 'community', tag: 'v1.0.0', fileManifestDigest: digest(), publishedAt: '2026-01-01T00:00:00.000Z' });
  assert.throws(() => signAndSelfVerify(b, key.privateKey, [pubPem]));
});

test('injection-y version input is flagged, never crashes', () => {
  for (const v of ['1.0.0; DROP TABLE', '../../etc', '1.0.0\n2.0.0', '${x}', 'v1.0.0', '1.0.0-rc.1']) {
    const p = checkReleaseInputs({ version: v, tag: `v${v}`, edition: 'community', fileManifestDigest: digest() });
    assert.ok(p.some((x) => /not plain SemVer/.test(x)), `should flag ${JSON.stringify(v.slice(0, 20))}`);
  }
});

test('version regex is ReDoS-safe on a pathological long input (returns fast)', () => {
  const started = Date.now();
  // A 100k-digit "major" is format-valid but absurd; the point is the linear regex must not hang.
  checkReleaseInputs({ version: '1'.repeat(100000) + '.0.0', tag: 'x', edition: 'community', fileManifestDigest: digest() });
  assert.ok(Date.now() - started < 500, 'linear regex must not blow up on long input');
});

test('readTrustedPublicKeys returns [] for a missing directory (no throw)', () => {
  assert.deepEqual(readTrustedPublicKeys('/nonexistent/release-keys-xyz'), []);
});

test('EDITION_DEFAULT is a non-empty string', () => {
  assert.equal(typeof EDITION_DEFAULT, 'string');
  assert.ok(EDITION_DEFAULT.length > 0);
});
