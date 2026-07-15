# Release signing keys

geneWeave releases are signed. Every release attaches a `manifest.json` carrying an **Ed25519 signature**; a
running instance applies a release only if that signature verifies against a **public key it trusts**. This
directory holds the **public** halves of the release signing keys so that:

- the **Release workflow** can self-verify each manifest it signs against a published key (a release fails to
  build if the signing secret doesn't match a key here — so a wrong/rotated key can never ship), and
- **adopters** can point their instances at these keys to trust genuine releases.

## Files

- `geneweave-community.pub.pem` — the community edition's release signing **public** key (SPKI PEM).

Each file is a **public** key. **No private key ever lives here or in the repo** — the private half is an offline
trust root stored only as the `GENEWEAVE_RELEASE_SIGNING_KEY` GitHub Actions secret.

## Trusting releases on an instance (adopters)

Point the Upgrade Center at this key so `check` accepts genuine releases. Either:

- **Env:** set `GENEWEAVE_UPGRADE_TRUSTED_KEYS` to the contents of `geneweave-community.pub.pem` (a PEM bundle —
  multiple keys may be concatenated), or
- **Admin UI / API:** save it as the source config's `trustedKeysPem`
  (`PUT /api/admin/upgrade/source { "trustedKeysPem": "<pem>" }`, platform-admin only).

The instance trusts a key by its fingerprint; a manifest signed by any other key is rejected `untrusted_key`.

## Rotating a key

The verifier trusts a **set** of keys, so rotation is additive and zero-downtime:

1. Generate a new keypair offline: `cd apps/geneweave && node scripts/gen-release-key.mjs`.
2. Commit the new **public** PEM here alongside the old one (both are trusted during the overlap window).
3. Update the `GENEWEAVE_RELEASE_SIGNING_KEY` secret to the new private PEM. New releases sign with the new key;
   instances already trusting either key keep working.
4. Once every instance trusts the new key, remove the old public PEM.

## Generating the initial key (one-time)

```bash
cd apps/geneweave
node scripts/gen-release-key.mjs            # prints the private PEM (→ secret) + public PEM (→ commit here)
# store the private PEM:
#   gh secret set GENEWEAVE_RELEASE_SIGNING_KEY   (paste the private PEM)
# commit the public PEM as release-keys/geneweave-community.pub.pem
```
