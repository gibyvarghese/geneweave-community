#!/usr/bin/env node
// gen-release-key.mjs — generate an offline Ed25519 RELEASE-SIGNING keypair for geneWeave.
//
// WHY THIS EXISTS
//   A geneWeave release is a signed `manifest.json` (build-release-manifest.mjs); an instance trusts it only
//   if it is signed by a key in the instance's trust set. That trust root is an Ed25519 keypair whose PRIVATE
//   half signs releases and whose PUBLIC half every instance is told to trust. This script mints that keypair
//   ONCE, offline, on a trusted machine. It reuses the framework's `generateAttestationSigningKey`
//   (@weaveintel/encryption) — the same Ed25519 construction the manifest signer/verifier uses — so there is
//   no bespoke crypto here.
//
// USAGE (run once, offline, then destroy the private key from this shell's history):
//   node scripts/gen-release-key.mjs                # prints PEMs + fingerprint + next steps
//   node scripts/gen-release-key.mjs --out ./keys   # also writes <fingerprint>.key.pem / .pub.pem to ./keys
//
// WHAT TO DO WITH THE OUTPUT (see release-keys/README.md):
//   • PRIVATE PEM  → store as the GitHub Actions secret GENEWEAVE_RELEASE_SIGNING_KEY (never commit it).
//   • PUBLIC  PEM  → commit to release-keys/geneweave-<edition>.pub.pem so releases can self-verify and
//                     adopters can trust it (set GENEWEAVE_UPGRADE_TRUSTED_KEYS to it).
//
// SECURITY: the private key is the release trust root. Generate it offline, never log it in CI, and rotate by
// generating a NEW keypair (the verifier trusts a SET of keys, so you can publish the new public key alongside
// the old during a rotation window).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAttestationSigningKey, fingerprintEd25519PublicKey } from '@weaveintel/encryption';

/**
 * Parse `--out <dir>` from argv.
 * @param {string[]} argv - process arguments.
 * @returns {{ outDir: string | null }} the output directory, or null to only print.
 */
function parseArgs(argv) {
  const i = argv.indexOf('--out');
  return { outDir: i >= 0 && argv[i + 1] ? argv[i + 1] : null };
}

const { outDir } = parseArgs(process.argv.slice(2));

// Mint the keypair (KeyObjects) and export both halves as PEM.
const { publicKey, privateKey } = generateAttestationSigningKey();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = fingerprintEd25519PublicKey(publicKey);

console.log(`\n# geneWeave release signing key — fingerprint ${fingerprint}\n`);
console.log('── PRIVATE key (→ GitHub Actions secret GENEWEAVE_RELEASE_SIGNING_KEY; NEVER commit) ──');
console.log(privatePem.trimEnd());
console.log('\n── PUBLIC key (→ commit to release-keys/geneweave-<edition>.pub.pem; adopters trust this) ──');
console.log(publicPem.trimEnd());

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const keyPath = join(outDir, `${fingerprint}.key.pem`);
  const pubPath = join(outDir, `${fingerprint}.pub.pem`);
  // 0o600 on the private key: it must not be world-readable even for the moment it sits on disk.
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  writeFileSync(pubPath, publicPem);
  console.log(`\nWrote:\n  ${keyPath}  (chmod 600 — move to your secret store, then delete)\n  ${pubPath}`);
}

console.log(`
Next steps:
  1. Store the PRIVATE PEM as the Actions secret:   gh secret set GENEWEAVE_RELEASE_SIGNING_KEY < <(printf '%s' "$PRIVATE_PEM")
  2. Commit the PUBLIC PEM:                          release-keys/geneweave-<edition>.pub.pem
  3. Tell instances to trust it (GENEWEAVE_UPGRADE_TRUSTED_KEYS), see release-keys/README.md.
`);
