#!/usr/bin/env node
// verify-release-manifest.mjs — independently verify a release manifest's provenance.
//
// WHY THIS EXISTS
//   A geneWeave release is a signed `manifest.json`. Two audiences need to confirm it is authentic — signed by a
//   trusted key, unmodified, for the right edition, and not expired — WITHOUT running a full instance:
//     • the Release workflow, as a gate AFTER signing and BEFORE publishing (defence in depth on top of the
//       publisher's own self-verify), and
//     • ADOPTERS, who download a release asset and want to check its provenance before trusting it.
//   This is that check. It reuses the exact verifier a running instance uses (`@weaveintel/upgrade`
//   createEd25519Verifier / verifyManifestSignature) and the publisher's `readTrustedPublicKeys`, so "trusted"
//   means the same thing everywhere. It does NOT re-implement edition/expiry/anti-rollback policy beyond a
//   surface check — the running Upgrade Center's UpdateChecker owns the full trust decision at apply time.
//
// USAGE:
//   node scripts/verify-release-manifest.mjs manifest.json                 # trust keys in ../../release-keys/
//   node scripts/verify-release-manifest.mjs manifest.json --keys key.pem  # trust a specific PEM (bundle ok)
//   node scripts/verify-release-manifest.mjs manifest.json --edition community --json
//   (env fallback for keys: GENEWEAVE_UPGRADE_TRUSTED_KEYS — the same var instances trust)
// Exit code: 0 if verified, 1 otherwise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseManifest, createEd25519Verifier, verifyManifestSignature } from '@weaveintel/upgrade';
import { readTrustedPublicKeys } from './build-release-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..'); // apps/geneweave/scripts → repo root

/**
 * Split a PEM bundle (possibly several concatenated public keys) into individual PEM blocks.
 * @param {string} text - PEM text, one or more `-----BEGIN PUBLIC KEY----- … -----END PUBLIC KEY-----` blocks.
 * @returns {string[]} each block as its own PEM string (empty if none).
 */
export function splitPemBundle(text) {
  return text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? [];
}

/**
 * Verify a manifest's provenance against a set of trusted public keys.
 * @param {string} manifestText - the manifest.json contents.
 * @param {string[]} trustedPems - trusted public keys (one PEM each).
 * @param {object} [opts]
 * @param {string} [opts.edition] - if set, require the manifest to be for this edition.
 * @param {() => Date} [opts.now] - clock injection for the expiry check (tests).
 * @returns {{ ok: boolean, problems: string[], manifest: object|null, fingerprint: string|null }}
 *   `ok` is true only if the manifest parses, its signature verifies against a trusted key, and any requested
 *   edition/expiry checks pass. Never throws — a malformed manifest or bad key is a problem, not an exception.
 */
export function verifyManifest(manifestText, trustedPems, opts = {}) {
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(manifestText));
  } catch (err) {
    return { ok: false, problems: [`not a valid manifest: ${err.message}`], manifest: null, fingerprint: null };
  }
  const fingerprint = manifest.signature.keyFingerprint;
  if (trustedPems.length === 0) return { ok: false, problems: ['no trusted public keys provided'], manifest, fingerprint };

  const problems = [];
  let verifier;
  try {
    verifier = createEd25519Verifier(trustedPems);
  } catch (err) {
    return { ok: false, problems: [`could not load trusted keys: ${err.message}`], manifest, fingerprint };
  }
  const sig = verifyManifestSignature(manifest, verifier);
  if (!sig.ok) problems.push(`signature ${sig.reason}`);
  if (opts.edition && manifest.edition !== opts.edition) problems.push(`edition mismatch: manifest is "${manifest.edition}", expected "${opts.edition}"`);
  if (manifest.expiresAt && (opts.now?.() ?? new Date()).getTime() > Date.parse(manifest.expiresAt)) problems.push('manifest is expired');

  return { ok: problems.length === 0, problems, manifest, fingerprint };
}

/** Parse `--flag value` / boolean flags from argv, plus the first positional (the manifest path). */
function parseFlags(argv) {
  const out = { file: null, keys: null, edition: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--keys') out.keys = argv[++i];
    else if (a === '--edition') out.edition = argv[++i];
    else if (!a.startsWith('--') && !out.file) out.file = a;
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = parseFlags(process.argv.slice(2));
  const fail = (msg) => { console.error(`✗ verify-release-manifest — ${msg}`); process.exit(1); };
  if (!flags.file) fail('usage: verify-release-manifest.mjs <manifest.json> [--keys <pem>] [--edition <e>] [--json]');

  // Resolve trusted keys: --keys file → GENEWEAVE_UPGRADE_TRUSTED_KEYS env → committed release-keys/.
  let trustedPems;
  if (flags.keys) trustedPems = splitPemBundle(readFileSync(flags.keys, 'utf8'));
  else if (process.env.GENEWEAVE_UPGRADE_TRUSTED_KEYS) trustedPems = splitPemBundle(process.env.GENEWEAVE_UPGRADE_TRUSTED_KEYS);
  else trustedPems = readTrustedPublicKeys(join(repoRoot, 'release-keys'));

  const res = verifyManifest(readFileSync(flags.file, 'utf8'), trustedPems, { edition: flags.edition });

  if (flags.json) {
    console.log(JSON.stringify({ ok: res.ok, fingerprint: res.fingerprint, version: res.manifest?.version, edition: res.manifest?.edition, problems: res.problems }, null, 2));
  } else if (res.ok) {
    console.log(`✓ verified: ${res.manifest.name}@${res.manifest.version} "${res.manifest.codename ?? ''}" (${res.manifest.edition}) — signed by trusted key ${res.fingerprint}`);
  } else {
    console.error(`✗ NOT verified${res.fingerprint ? ` (signing key ${res.fingerprint})` : ''}:`);
    for (const p of res.problems) console.error(`  - ${p}`);
  }
  process.exit(res.ok ? 0 : 1);
}
