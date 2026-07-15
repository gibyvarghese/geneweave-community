# geneWeave Upgrade Engine — Runbooks

Practical, copy-paste procedures for the people who operate, publish, and customize a geneWeave instance. All
routes are platform-admin only and dialect-neutral (SQLite or Postgres). For how the engine works, see
[`UPGRADE_ENGINE.md`](UPGRADE_ENGINE.md); for the security posture see [`THREAT_MODEL.md`](THREAT_MODEL.md).

---

## Operator runbook — applying a release

The lifecycle is **check → preflight → preview → apply → verify → review**. Every step is a platform-admin API
call; nothing mutates until `apply`.

1. **Check for an update.** `POST /api/admin/upgrade/check` polls the release source, verifies the manifest
   signature, checks edition + expiry + anti-rollback, and records the outcome.
   - `not_configured` → set `GENEWEAVE_UPGRADE_REPO` and `GENEWEAVE_UPGRADE_TRUSTED_KEYS` (see below).
   - `rejected` with a reason (`bad_signature` / `untrusted_key` / `expired` / `downgrade` / `edition_mismatch`)
     → do **not** proceed; the release is not trustworthy. Investigate the source.
   - `update_available` → continue.
2. **Preflight.** `POST /api/admin/upgrade/preflight` — read-only gates: stale `@weaveintel/*` packages, disk
   headroom, an already-held upgrade lock, unresolved prior P1s, edition entitlement. Fix anything failing.
3. **Preview.** `POST /api/admin/upgrade/preview` — read-only four-layer plan (packages / code / schema /
   content) with counts. **Mutates nothing.** This is the default first look.
4. **Apply.** `POST /api/admin/upgrade/apply` — snapshots first, raises maintenance, runs L1→L4, verifies, and
   **auto-rolls-back** on failure. Outcomes: `succeeded`, `succeeded_with_pending` (items in the review queue),
   `rolled_back` (restored to where you were — safe), `busy` (another upgrade holds the lock), `preflight_failed`.
5. **Review.** Open the Upgrade Center → the queue is grouped by priority. Resolve by keyboard (1 keep / 2 adopt
   / 3 merge / d defer), or bulk (never P1), or let **resolution rules** auto-resolve the safe items
   (`POST /api/admin/upgrade/rules/apply`). See the automation section of `UPGRADE_ENGINE.md`.

**Rolling back a bad release after the fact.** A successful apply retains its pre-upgrade snapshot.
`POST /api/admin/upgrade/rollback { "runId": "<id>" }` restores it. (An in-flight failure already rolled back
automatically.)

**Crash during apply.** Re-run `apply`. It resumes the same run — the schema ledger skips already-applied
batches and the content reconcile is content-addressed, so it converges without double-applying.

**Housekeeping.** Periodically `POST /api/admin/upgrade/prune-versions` to bound `realm_versions` growth (it
keeps the head window, every live-referenced Base, and every tenant-pinned version). Run with
`{ "dryRun": true }` first to see the plan.

---

## Publisher runbook — cutting a release

A release is a **`v<x.y.z>` git tag** plus a **GitHub Release** carrying a signed `manifest.json`. Cutting one is
automated by the **Release workflow** ([`.github/workflows/release.yml`](../.github/workflows/release.yml)); an
instance trusts the result only if the manifest is signed by a key in its trust set.

### One-time setup — the signing key (offline trust root)

```bash
cd apps/geneweave
node scripts/gen-release-key.mjs        # prints the PRIVATE PEM (→ secret) + PUBLIC PEM (→ commit) + fingerprint
```

- Store the **private** PEM as the `GENEWEAVE_RELEASE_SIGNING_KEY` Actions secret (it never leaves your machine
  except into the secret store): `gh secret set GENEWEAVE_RELEASE_SIGNING_KEY`.
- Commit the **public** PEM as `release-keys/geneweave-community.pub.pem` (see
  [`release-keys/README.md`](../release-keys/README.md)). The workflow **self-verifies** each manifest against
  this key and fails closed if the secret doesn't match — so a wrong/rotated key can never ship a release.
- Tell instances to trust it: set `GENEWEAVE_UPGRADE_TRUSTED_KEYS` (or the source config's `trustedKeysPem`) to
  that public PEM.

### Cutting a release

One command bumps the version, rolls the changelog, updates VERSIONING.md, and tags — validating the result
against the product-version guard before it commits, so the tag it produces is guaranteed to pass CI:

```bash
# add your notes under "## [Unreleased]" in CHANGELOG.md first, then:
npm run release:product minor              # or patch | major | --set 1.2.0   (preview with --dry-run)
git push origin HEAD && git push origin v<x.y.z>   # cut the release (or pass --push to do both)
```

Both editions share ONE product version — run the same version in the private repo
(`npm run release:product --set <x.y.z>`); the lockstep guard fails CI if they diverge. Then:

1. The push of `v<x.y.z>` triggers the Release workflow, which builds and runs `scripts/build-release-manifest.mjs`, which:
   - computes `layers.code.fileManifestDigest` via `fetchTreeBaseline` — the **same** function every instance
     re-verifies with, so the digest is guaranteed to match the tag's source tree;
   - assembles the manifest body (`version`, fabric `codename`, `edition`, `layers.code.repoTag = the tag`),
     **lints** it (`@weaveintel/upgrade` `lintManifest`), **signs** it with the secret, and **self-verifies**
     against the committed public key;
   - the workflow attaches `manifest.json` to the GitHub Release.
4. **Anti-rollback is automatic:** clients compute a floor from the max accepted version, so a replayed older
   (but validly signed) manifest is rejected as a downgrade.

Declaring schema (`layers.schema`) and content (`layers.content`) entries is supported by the manifest and the
publisher accepts them, but the L3/L4 reconcile also runs at *apply* time from the fetched code + live DB, so a
code-layer manifest already drives a correct upgrade. To bound freeze attacks, an `expiresAt` may be set on the
manifest (a stale mirror serving an old manifest forever is rejected once expired).

To run the publisher locally against a tag (dry run): `GENEWEAVE_RELEASE_SIGNING_KEY=… GENEWEAVE_UPGRADE_REPO=owner/repo
RELEASE_TAG=v1.0.0 npm run release:manifest -- --out /tmp/manifest.json` (from `apps/geneweave`).

**Propagating triage across a fleet.** Resolve the queue once on staging, then
`POST /api/admin/upgrade/resolutions/export` to emit a **signed** resolution bundle;
`POST /api/admin/upgrade/resolutions/import` on production replays it — matching on `(family, logical_key,
remote_hash)`, skipping any item whose shipped content differs, and never auto-resolving a P1. Production trusts
the exporter's key via `GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS`.

---

## Community code-upgrade runbook (L2, git-native)

The Community edition's application code lives in a public git repo, so code upgrades are resolved with standard
git tools — no geneWeave-specific merge UI required.

1. `POST /api/admin/upgrade/code/baseline` once to capture the installed tree as the L2 baseline (needed only on
   a non-git install; a git worktree uses the tag directly).
2. `GET /api/admin/upgrade/code/status` shows which vendor files you've edited.
3. On a release, the scanner classifies every file (unchanged / operator-modified / vendor-updated / both) and
   auto-merges what merges cleanly with diff3. **Conflicts are written with standard diff3 markers onto an
   `upgrade/v<target>` git branch** — resolve them in any editor, mergetool, or PR, then push. A file still
   carrying conflict markers keeps the schema layer (L3) blocked until resolved.
4. Or resolve them **in-app**: in the Upgrade Center's **Code** section, click **Scan release** to detect the
   release's conflicts (a three-way scan against the accepted release's git refs), then open one — a split
   `@codemirror/merge` editor shows the incoming release version beside a base-informed pre-merge you edit, with
   per-chunk accept-incoming arrows, a live remaining-conflict count, and *Apply* gated until no markers remain.
   *Apply resolution* writes it to the working tree and clears the review item (it refuses any text still
   carrying conflict markers). The in-app editor sources the release/installed file versions from git — it needs
   a git work tree (set `GENEWEAVE_SOURCE_ROOT` to it, and `GENEWEAVE_SOURCE_BASE_REF` if the installed tag
   isn't `v<version>`); on a non-git deploy it points you back at the branch above.
5. `turbo typecheck` gates the merged tree before it's accepted.

---

## Private-edition setup runbook (locked code + token vaulting)

The Private/commercial edition locks the vendor tree and pulls releases from a **closed** repo. Two extra pieces
of setup:

1. **Authenticated release source.** Point the engine at the private repo and supply a GitHub token. **Store the
   token in the app's encrypted credential vault, never as plaintext.**
   - Put the token in the vault and set `GENEWEAVE_UPGRADE_TOKEN_CREDENTIAL_ID` to its credential id (decrypted
     per-call via the vault, never logged, never retained). Requires `VAULT_KEY` to be set (the vault master
     key).
   - A plaintext `GENEWEAVE_UPGRADE_TOKEN` is honored as a fallback for dev only — do not use it in production.
2. **Edition policy.** Set `GENEWEAVE_EDITION` to the private edition. Preflight refuses a manifest whose
   `edition` doesn't match (a community instance ignores private releases and vice versa). L2 runs in **locked**
   mode: the vendor tree is swapped wholesale and operator customizations live as sanctioned patch files that
   reapply after the swap; a patch that no longer applies cleanly enters the review queue as a P1 (never
   silently dropped). L3/L4 (schema, seeded data, governance, pins, the review queue) are identical to Community.

**Signing keys for resolution bundles** follow the same vaulting pattern: prefer
`GENEWEAVE_UPGRADE_SIGNING_KEY_CREDENTIAL_ID` (a vault credential) over the plaintext
`GENEWEAVE_UPGRADE_SIGNING_KEY`.

---

## Telemetry runbook

Telemetry is **local and opt-out**. By default the instance records LLM run traces and a PII-free stream of
upgrade-lifecycle events into its own database — nothing is sent anywhere. To disable it entirely set
`GENEWEAVE_TELEMETRY=0` or `DO_NOT_TRACK=1`. To export telemetry to your own OpenTelemetry collector, set
`OTEL_EXPORTER_OTLP_ENDPOINT`. Read recent upgrade events with `GET /api/admin/upgrade/telemetry`.
