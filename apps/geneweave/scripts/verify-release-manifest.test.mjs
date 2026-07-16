// verify-release-manifest.test.mjs — tests for the independent provenance verifier.
//
// Run with:  node --test scripts/verify-release-manifest.test.mjs   (from apps/geneweave)
//
// Ephemeral Ed25519 keys sign real manifests (buildManifest); the verifier is then checked to ACCEPT a genuine
// one and REJECT a tampered / untrusted-key / wrong-edition / expired / malformed one — with a 1k+10k parallel
// pass measuring latency percentiles and proving no-cross-trust-leakage under volume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { verifyManifest, splitPemBundle } from './verify-release-manifest.mjs';
import { buildManifest } from '@weaveintel/upgrade';
import { generateAttestationSigningKey, fingerprintEd25519PublicKey } from '@weaveintel/encryption';

const key = generateAttestationSigningKey();
const otherKey = generateAttestationSigningKey();
const pub = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPub = otherKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const digest = `sha512-${createHash('sha512').update('tree').digest('base64')}`;

const body = (version = '1.0.0', edition = 'community', expiresAt) => ({
  manifestVersion: 1, name: '@weaveintel/geneweave-api', version, codename: 'Aertex', channel: 'stable', edition,
  publishedAt: '2026-01-01T00:00:00.000Z', ...(expiresAt ? { expiresAt } : {}),
  requires: { node: '>=20' }, layers: { packages: [], schema: [], content: [], code: { repoTag: `v${version}`, fileManifestDigest: digest } }, artifacts: [],
});
const signed = (b = body(), k = key.privateKey) => JSON.stringify(buildManifest(b, k));

// ── (1) Positive ────────────────────────────────────────────────────────────────────────────
test('verifies a genuine manifest against a trusted key', () => {
  const r = verifyManifest(signed(), [pub]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.fingerprint, fingerprintEd25519PublicKey(key.publicKey));
  assert.equal(r.manifest.version, '1.0.0');
});

test('edition + non-expired checks pass when they match', () => {
  const r = verifyManifest(signed(body('1.0.0', 'community', '2027-01-01T00:00:00.000Z')), [pub], { edition: 'community', now: () => new Date('2026-06-01') });
  assert.equal(r.ok, true);
});

test('splitPemBundle splits one or many concatenated keys', () => {
  assert.equal(splitPemBundle(pub).length, 1);
  assert.equal(splitPemBundle(pub + '\n' + otherPub).length, 2);
  assert.equal(splitPemBundle('not a pem').length, 0);
});

// ── (2) Negative ────────────────────────────────────────────────────────────────────────────
test('a tampered manifest fails: bad signature', () => {
  const m = JSON.parse(signed());
  m.version = '9.9.9';
  const r = verifyManifest(JSON.stringify(m), [pub]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /signature bad_signature/.test(p)));
});

test('an untrusted signing key fails: untrusted_key', () => {
  const r = verifyManifest(signed(body(), otherKey.privateKey), [pub]);
  assert.ok(r.problems.some((p) => /signature untrusted_key/.test(p)));
});

test('no trusted keys → not verified (never throws)', () => {
  const r = verifyManifest(signed(), []);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no trusted public keys/.test(p)));
});

test('malformed manifest text → not a valid manifest (never throws)', () => {
  assert.equal(verifyManifest('{not json', [pub]).ok, false);
  assert.equal(verifyManifest(JSON.stringify({ nope: 1 }), [pub]).ok, false);
});

test('edition mismatch is reported', () => {
  const r = verifyManifest(signed(body('1.0.0', 'community')), [pub], { edition: 'enterprise' });
  assert.ok(r.problems.some((p) => /edition mismatch/.test(p)));
});

test('expired manifest is reported', () => {
  const r = verifyManifest(signed(body('1.0.0', 'community', '2026-02-01T00:00:00.000Z')), [pub], { now: () => new Date('2026-07-01') });
  assert.ok(r.problems.some((p) => /expired/.test(p)));
});

// ── (4) Concurrency / load ──────────────────────────────────────────────────────────────────
for (const N of [1000, 10000]) {
  test(`concurrency: ${N} parallel verifies — all correct, latency measured`, async () => {
    const m = signed();
    const lat = new Array(N);
    const results = await Promise.all(Array.from({ length: N }, (_, i) => async () => {
      const t0 = process.hrtime.bigint();
      const ok = verifyManifest(m, [pub]).ok;
      lat[i] = Number(process.hrtime.bigint() - t0) / 1e6;
      return ok;
    }).map((f) => f()));
    const started = Date.now();
    assert.equal(results.filter((r) => !r).length, 0);
    const wall = Date.now() - started;
    lat.sort((a, b) => a - b);
    const pct = (p) => lat[Math.min(N - 1, Math.floor((p / 100) * N))].toFixed(3);
    console.log(`  ${N} verifies — p50=${pct(50)}ms p95=${pct(95)}ms p99=${pct(99)}ms`);
  });
}

test('no cross-trust leakage: a verifier trusting only key A rejects 1000 manifests signed by key B', async () => {
  const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => async () =>
    verifyManifest(signed(body(`1.0.${i}`), otherKey.privateKey), [pub]).ok).map((f) => f()));
  assert.equal(results.filter((ok) => ok).length, 0, 'none signed by the untrusted key may verify');
});
