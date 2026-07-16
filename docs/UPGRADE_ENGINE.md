# The geneWeave Upgrade Engine

geneWeave keeps a running instance in step with new releases without ever losing what you changed. This
document describes how that works today — the mechanism, the data it keeps, and the knobs you have.

It builds directly on the Tenancy Realm (per-tenant configuration): the realm already knows, for every
built-in default, whether it's the shipped global, a tenant's own copy, or a shared copy, and it can
three-way-merge two versions of a record. The upgrade engine uses that same machinery at the *global*
level to keep the built-ins themselves current.

## The model: shipped defaults are like `/etc` config files

Your instance is seeded with built-in defaults — prompts, skills, guardrails, tool/routing/cost policies,
prompt strategies/contracts/frameworks, and more. Over time two things happen independently: **you** edit
some defaults to suit your deployment, and **new releases** change some of those same defaults. When both
happen to the same record, blindly taking either side is wrong.

This is exactly the problem a Linux package manager solves for a config file you edited in `/etc`. geneWeave
solves it the same way, by comparing three versions of each default:

| | meaning |
|---|---|
| **Base** | what the product shipped *last* time (recorded when it was last seeded) |
| **Local** | what's in your database *now* (carries any edits you made) |
| **Remote** | what *this* release wants to ship |

and classifying each default:

| classification | condition | what happens |
|---|---|---|
| **in&nbsp;sync** | you didn't touch it, we didn't change it | nothing to do |
| **stale** | you didn't touch it, we changed it | **adopted automatically** (you get our improvement) |
| **customized** | you edited it, we didn't | **kept** — your version stands, flagged for visibility |
| **diverged** | both changed | **kept**, surfaced for a three-way merge (never guessed) |
| **new** | we ship a default you don't have yet | published |
| **removed** | you have a managed default we no longer ship | flagged, **never auto-deleted** |

"Local" is always hashed **live from the row**, so an out-of-band edit is always noticed, and an
edit-then-revert returns cleanly to *in sync* with no phantom "customization".

## When it runs

On every startup, after all seed data is in place, geneWeave reconciles the whole registry of built-in
families. It's content-addressed, so a boot where nothing changed is a cheap no-op. A fresh install simply
records baselines for everything (there's nothing to reconcile yet); an upgrade adopts the safe changes and
flags the rest.

Two behaviours are deliberately preserved on a **fresh install only**: the first-run detection (so nothing
below ever overrides a returning operator's later choices) and the lean guardrail default (LLM-judge
guardrails start off unless you set `GENEWEAVE_ENABLE_LLM_JUDGES=1`).

## What it records

Every reconcile opens an **upgrade run** and writes one **detail** row per record it touched: the family and
key, what was decided, the three content hashes (for the merge view), and a **priority band**:

| band | families / cases |
|---|---|
| **P1** | guardrails, and any collision or genuine both-sides conflict — never auto-resolved, never bulk-resolved |
| **P2** | skills, workflows, worker agents |
| **P3** | tool / routing / cost policies, prompt catalog, registry config |
| **P4** | capability scores, task-type catalog |
| **P5** | model pricing, labels |

So after a release lands you have a durable, prioritised record: what was adopted for you, what was kept
because you'd customised it, and what still needs attention.

## Per-family adoption policy

How eagerly a family adopts a *stale* default (one you never touched) is a per-family policy: `always`
(safe informational config), `patch_only` (the default — adopt untouched changes, keep edits), or `never`
(surface even untouched changes for explicit review). The policy is conservative by default and easy to
audit in one place.

Each family ships with a built-in default, and an operator can **override it per family** by writing a row to
`upgrade_family_policy` (`PUT /api/admin/upgrade/family-policy/:family { policy }`). An override steers the very
next reconcile — e.g. setting `skills` to `never` makes even an untouched skill change surface for review
instead of adopting automatically. Overrides are **governed config**: the policy table is a realm family, so a
change flows through the same propose → review → promote dual-control every other catalog change does. With no
override rows, behaviour is identical to the built-in defaults.

## Structured fields (workflows)

Most built-ins are flat records, and the reconcile compares them field by field. A workflow is different:
its `steps` is a graph of nodes, each carrying its own wiring. Treating that as one atomic value would make
a release adding a node conflict with a tenant re-wiring a *different* node. So the merge for workflows is
**per node**: a node the tenant never touched that the release changed is upgraded; a node the tenant
customised is kept; a node either side *added* coexists; only a node both sides changed differently is a
conflict — and even then the tenant's version is kept and flagged, never lost. The same three-way logic,
applied to each node instead of the whole field.

This per-node merge runs everywhere a workflow is merged — the boot reconcile, the review queue's *adopt*, and
the field-level merge in the realm workbench — so a release that adds a node never spuriously conflicts with a
tenant re-wiring of a different node; only the same node changed on both sides needs a human.

## Coverage

The reconcile covers every built-in family the product ships — prompts, skills, guardrails, tool/routing/cost
policies, prompt strategies/contracts/frameworks/fragments, worker agents, workflows, the model catalog
(pricing, task types, provider tool adapters, **model capability scores**), the live-agent registries
(handler kinds, attention policies), and scaffold templates. Registering a family is additive: it gets the
standard realm columns and joins the reconcile automatically.

Capability scores are the one family that keys on a **composite cell** — `(provider, model, task)` — rather
than a single natural key, and their owner column (`owner_tenant_id`) replaced an older `tenant_id`-based
scheme when they were converged onto the standard pattern. Their content hash covers only the *shipped* config
fields (quality, capability flags, active state); the auto-updating production-telemetry signals are excluded,
so a live install that's accumulating signals never reads as "drifted".

## Checking for updates

geneWeave can discover a new release, prove it's genuine, and decide whether it's actually for you — before
anything is applied. A platform admin runs the check (`POST /api/admin/upgrade/check`); the most recent
result is at `GET /api/admin/upgrade/status`.

A release ships a **signed manifest** — its version, edition, expiry, and the four layers it changes. The
check fetches the latest manifest from the release source (through the resilient HTTP pipeline), then trusts
it only after it passes, in order, with a distinct reason for each failure:

| check | rejected when |
|---|---|
| **signature** | not signed by a key you trust, or tampered (`untrusted_key` / `bad_signature`) |
| **edition** | it's a release for a different edition (`edition_mismatch`) |
| **freshness** | it's past its expiry (`expired`) |
| **anti-rollback** | it's older than what you already have (`downgrade`) |

Every check is recorded in `upgrade_releases` — an audit trail, and the **anti-rollback floor**: the highest
version you've ever *accepted*. A later check is judged against `max(installed, that floor)`, so a replayed
old-but-validly-signed manifest can never talk your instance into a downgrade. A rejected release is recorded
but never raises the floor.

The check answers with your **deployed** version and the release's version, and the Upgrade Center renders them
side by side — `Deployed v1.4.0 → Available v1.5.0 · update available` — with an **Upgrade** button when a
newer release is trusted (it walks you into Preview → Apply). When you're current it reads *up to date*; a
release that failed a gate reads *rejected: <reason>*.

### Configuring the release source

Point your instance at the repo releases come from **from the Upgrade Center** (a platform-admin action) — no
redeploy or env change needed. The source is a single, platform-wide record (`GET`/`PUT
/api/admin/upgrade/source`, stored in `upgrade_source_config`):

| field | meaning |
|---|---|
| **repo** | the `owner/repo` GitHub releases are published to |
| **edition** | this instance's edition (a release for another edition is rejected) — `community` or your enterprise edition |
| **trusted signing keys** | a PEM bundle of the Ed25519 **public** keys you trust; a release is trusted only if signed by one of them |
| **GitHub API base** | optional — set it for GitHub Enterprise; blank uses public github.com |
| **private-repo token** | optional — the *credential-id* of a bearer token held in the encrypted vault (for a private enterprise release repo). The token itself is never stored in this record, only referenced |

The keys are public and safe at rest; **no secret is ever stored in this record** — a private-repo token lives
in the credential vault and is referenced by id, decrypted per check, and never logged. The source is a
property of the deployment, so it is platform-global (not per-tenant).

For headless or bootstrap deploys the same settings can be supplied as environment variables; the stored config
takes precedence, and env is the fallback (unset both = the check reports `not_configured`):

| variable | meaning |
|---|---|
| `GENEWEAVE_UPGRADE_REPO` | the `owner/repo` GitHub releases are published to |
| `GENEWEAVE_UPGRADE_TRUSTED_KEYS` | a PEM bundle of the Ed25519 public keys you trust to sign releases |
| `GENEWEAVE_EDITION` | this instance's edition (default `community`) |
| `GENEWEAVE_UPGRADE_ASSET` | the manifest asset's file name (default `manifest.json`) |
| `GENEWEAVE_UPGRADE_TOKEN` / `GENEWEAVE_UPGRADE_TOKEN_CREDENTIAL_ID` | a bearer token for a **private** release repo — a vault credential id (preferred) or a plain token; used only in the `Authorization` header, never logged |

The signing/verification, manifest schema, and release sources are the brand-neutral
[`@weaveintel/upgrade`](https://www.npmjs.com/package/@weaveintel/upgrade) package; geneWeave supplies the
persistence, the resilient HTTP, the stored source config, and the admin route.

### Verifying a release's provenance

Every release is a `v<x.y.z>` git tag and a GitHub Release carrying an **Ed25519-signed `manifest.json`**. Trust
is enforced at three points, so a tampered, unsigned, or backwards release never reaches an instance:

1. **At release time** (the [Release workflow](../.github/workflows/release.yml)) the tag is gated as SemVer +
   matching the product version + **newer than every existing tag** (anti-rollback), the manifest is signed, and
   then **independently re-verified** against the repo's published public key before the Release is published.
2. **On the instance**, the Upgrade Center's `check` verifies the signature against your **trusted keys**, refuses
   another edition, an expired manifest, or a downgrade — each with a distinct reason — before anything is
   trusted.
3. **By you, out of band.** The published public keys live in [`release-keys/`](../release-keys/). To verify a
   downloaded release yourself:

   ```bash
   cd apps/geneweave
   npm run verify:release-manifest -- <path/to/manifest.json>            # trusts release-keys/
   #   ✓ verified: @weaveintel/geneweave-api@1.2.0 "Aertex" (community) — signed by trusted key <fingerprint>
   node scripts/verify-release-manifest.mjs manifest.json --keys my.pem --edition community --json
   ```

   Exit code `0` means verified; `1` prints the distinct reason (`signature bad_signature` / `untrusted_key`,
   `edition mismatch`, `expired`, or a malformed manifest). It uses the *same* verifier the instance uses, so a
   pass here means the instance will accept it too.

## Preflight: is it safe to apply?

Before applying an accepted release, a platform admin can run **preflight** (`POST /api/admin/upgrade/preflight`) —
a set of read-only gates that answer "is it safe to apply this release *right now*?" without changing anything.
You can run it any time, well ahead of a maintenance window, and fix what it flags in advance. It reports each
gate with a pass/fail and a plain reason:

| gate | passes when |
|---|---|
| **packages** | every platform package the release *requires* is installed at a satisfying version (it names any that are stale or missing — content and schema assume the matching library code, so a stale package is a hard blocker) |
| **mutex** | no other upgrade operation currently holds the instance lock |
| **disk** | enough free space on the database's volume for the pre-upgrade snapshot (a managed Postgres server's disk isn't observable from the app, so it's reported *skipped* rather than blocking) |
| **unresolved&nbsp;P1** | no P1 review item from a prior run is still open (P1s are never auto-resolved, so they must be cleared first) |
| **edition** | the release targets this instance's edition |

Preflight only reads — SELECTs, a lock check, and filesystem probes; it never writes.

## Preview: exactly what an apply would do

**Preview** (`POST /api/admin/upgrade/preview`) is the read-only plan and the natural first step. It classifies
every change the accepted release ships, across all four layers, and persists the plan as an upgrade run (mode
`preview`) with one detail row per item — so the Upgrade Center can show "here's precisely what will happen"
before you commit. It applies **nothing**: no package is installed, no migration runs, no seeded default is
touched (a test asserts every content table is byte-for-byte identical afterwards; the only writes are the
preview's own record).

| layer | what preview shows |
|---|---|
| **L1 packages** | which required platform packages are stale (installed version doesn't satisfy the release) |
| **L2 code** | the application-code tag the release targets; the running instance can't self-apply code (it ships via package/deploy), so this is reported as *requires deploy* |
| **L3 schema** | which migration batches the release declares that aren't in this instance's ledger yet (would run) versus those already applied |
| **L4 content** | for each shipped default, the three-way classification — using the **same live-row hashing** the boot-time reconcile uses (Base = the row's recorded `origin_hash`, Local = the live row hashed now, Remote = the manifest's declared hash) — so you see, per record, whether the release would auto-adopt it (*stale*), keep your edit (*customized*), or need a three-way merge (*diverged*), banded by the same P1–P5 priorities. A shipped family this build doesn't know yet is skipped, not an error. |

The mutex is a single-row advisory lock (`upgrade_lock`): acquisition is a compare-and-set that both engines
serialise on the one row, so exactly one upgrade operation runs at a time, and a lock abandoned by a crashed
holder is reclaimable after a staleness window.

## Applying a release

**Apply** (`POST /api/admin/upgrade/apply`) is the mutating step: it runs the four layers in order (L1 → L2 →
L3 → L4), each gating the next, under the mutex and a pre-upgrade snapshot, and records everything it does as an
`apply` run with per-item detail rows. It raises the **maintenance flag** for the mutating window, and clears it
when done.

The engine deliberately splits *deploy* from *data*. A running server can't npm-install and hot-swap its own
dependencies (L1) or git-merge and typecheck its own source (L2) — those produce the artifact the server runs.
So you deploy the new packages and code, then apply brings the **data plane** into line with them:

| layer | what apply does |
|---|---|
| **L1 packages** | preflight has already verified the required packages are present; apply records them |
| **L2 code** | records the target code tag; the L2 mode is chosen by edition — **`merge`** (Community: upstream is merged per-file) or **`locked`** (Private: the vendor tree is swapped wholesale). An unresolved merge conflict **defers** the schema batches that depend on that file |
| **L3 schema** | runs the not-yet-applied migration batches in **strict** mode — a failing statement aborts and restores the snapshot rather than leaving a half-applied schema. Deferred batches stay pending for a later apply once their code lands |
| **L4 content** | the registry reconcile (the same one that runs at boot) under this run: safe changes adopt, your edits are kept, genuine conflicts are flagged. Families whose schema was deferred are held back |

Apply is **item-granular**: it finishes `succeeded`, or `succeeded_with_pending` when it applied cleanly but
left review items (a genuine conflict, a collision, a deferral) — those never hold the whole upgrade hostage.
If an L3 batch fails, the snapshot is restored and the run finishes `rolled_back`. Because L3 is ledgered and
L4 is content-addressed, a crash mid-apply is safe to **resume**: re-running continues the same `running` run
and every already-applied batch or adopted record is skipped — nothing is applied twice.

Two safety proofs the engine guarantees and the tests assert: an operator's **customized** records and every
**tenant-owned** row are byte-for-byte identical after an apply (your edits are kept; tenant rows are invisible
to the global reconcile by construction), and a **deferred** batch holds exactly its dependents until the code
it needs is merged.

### One-click upgrade

The Upgrade Center's **Upgrade** button (`POST /api/admin/upgrade/run`) runs the whole flow as one action so an
operator doesn't drive the steps by hand:

1. **Preflight** — if a hard gate fails the run stops and returns the failing gates (nothing is mutated); pass
   `{ force: true }` to override.
2. **Derive the code gate** — the unresolved code conflicts already recorded (from a scan) become the
   `unresolvedCodePaths` automatically, so any file you edited that the release also changed defers its dependent
   schema + data. You never pass that list by hand.
3. **Apply** — as above.
4. **Outcome** — a plain-language result: the **bump type** (patch · minor · major, by semver), how many
   un-customized items were auto-updated, and the honest follow-up: *"N code files you changed also changed
   upstream — merge them, then redeploy"* (Community), or *"redeploy to run the new code"* / *"nothing to
   deploy"*. The version panel shows the same bump badge next to *update available* so you can gauge risk before
   you click.

The split still holds: config and data are applied live; code changes take effect on the next deploy. For a
Private/enterprise instance (which doesn't edit code) there are no per-file merges — the outcome just reports the
data changes and that a redeploy will run the new code.

## Verify and rollback

Applying the changes isn't the finish line — the engine then **verifies** the instance actually works, and can
**roll back** unattended if it doesn't. This closes the gap between "the upgrade applied" and "the upgrade is
good."

**Verify** runs right after the content layer, while the pre-upgrade snapshot is still held, and checks three
things:

| check | asserts |
|---|---|
| **readiness** | the database is reachable and the engine's own ledger tables are present |
| **manifest invariants** | every non-deferred schema batch the release declared is applied; every content family it ships is a real family whose table exists; every required platform package is satisfied |
| **`@upgrade-critical`** | an *optional* out-of-process smoke suite (e.g. the Playwright `@upgrade-critical` subset) — wired by the operator; absent means it's simply skipped |

If any check fails, the apply **restores the pre-upgrade snapshot unattended** — the instance goes back exactly
where it was — finishes the run `rolled_back`, and files a **P1 audit** item so the failure is visible and
blocks the next apply until acknowledged. (A migration that fails mid-apply triggers the same restore even
before verify runs.)

A run that verifies cleanly **retains its snapshot** so it can still be reversed later if a problem only shows
up in production. A platform admin rolls a specific run back with `POST /api/admin/upgrade/rollback` (`{ "runId": "…" }`):
the engine restores that run's retained snapshot, marks it `rolled_back`, and files the audit. Retention is
bounded — only the newest successful apply keeps its snapshot, so you can always undo the last upgrade; an
older run whose snapshot was superseded reports `no_snapshot`.

## The Upgrade Center

Everything above has a screen. The **Upgrade Center** (Admin → Governance → Upgrade Center, platform-admin only)
is a stepper over the lifecycle — **Check → Preview → Apply** — landing on the **review queue** for whatever the
apply couldn't settle automatically.

The review queue is keyboard-driven, mirroring the priorities the engine records (P1 first):

| key | action |
|---|---|
| **j / k** | move the cursor down / up the queue |
| **1** | *keep mine* — your version stands (marked resolved, no data change) |
| **2** | *adopt incoming* — take the shipped upstream (the record is re-baselined; **undoable**) |
| **d** | *defer* — leave it, with a comment |
| **u** | *undo* the last resolution (an adopt is reverted to the exact prior record) |

**Bulk with a guardrail.** "Keep-mine all (non-P1)" resolves a whole family in one action — but a **P1** item (a
guardrail change or a genuine conflict) is **never** resolved in bulk, enforced on the server, not just hidden in
the UI. A running tally counts the queue down to zero.

**Needs attention.** Alongside the queue, a "needs attention" scan lists, for any family, the records that have
drifted from the shipped default *or* lag behind the latest published version — each with its drift badge and,
when it trails, the amber "v3 · v5 available" lagging badge. It's a read-only overview
(`GET /api/admin/upgrade/attention?family=…`) built from the drift report + the version log, so an operator can
see what to review without opening each record.

Each adopt snapshots the record's prior state, so **undo restores it verbatim** — the drift badge (`in sync` /
`customized` / `diverged`, and the amber "v3 · v5 available" lagging form) tracks the truth across
edit → upgrade → adopt → revert. The record panel reuses the realm workbench's field-level three-way diff, so a
genuine conflict is merged field by field, never guessed.

The review actions are HTTP endpoints too, for automation:

| endpoint | does |
|---|---|
| `GET /api/admin/upgrade/review` | the queue (unresolved items, P1→P5, with tallies) |
| `POST /api/admin/upgrade/review/:id/resolve` | keep / adopt / defer one item |
| `POST /api/admin/upgrade/review/bulk` | bulk resolve (P1 never touched) |
| `POST /api/admin/upgrade/review/:id/undo` | re-open a resolved item (an adopt is reverted) |
| `GET /api/admin/upgrade/attention?family=…` | the drifted + version-lagging records in a family |

## Automating the queue with resolution rules

Triaging the same low-risk items release after release is toil, so the queue can be **automated with rules**.
A resolution rule matches unresolved items by any of family, priority, or disposition (an absent dimension
means "any") and carries an action — **keep**, **adopt**, **defer**, or **tag**. `POST /api/admin/upgrade/rules/apply`
walks the queue and applies the **first matching rule** per item, lowest `seq` first, stamping every automated
resolution `resolution_source = 'automation'` for audit. So "auto-adopt every P5 pricing update" or "keep-mine
all diverged prompts" becomes a standing rule instead of a repeated click.

Two invariants make this safe:

- **A P1 is never auto-resolved.** A guardrail change, a namespace collision, or a genuine both-sides conflict
  is refused by any resolving rule — the same hard guardrail that blocks bulk resolve. A rule may only `tag` a
  P1 (annotate it for triage), never keep/adopt/defer it.
- **Rules are governed config.** The rules table is a realm family, so *changing a rule* flows through the same
  propose → review → promote dual-control as any catalog change — automation can't be silently re-pointed.

An automation pass is serialized by the upgrade mutex, so two passes can't race; the terminal resolution write
is a single-shot claim (`WHERE resolution IS NULL`), so every item is resolved exactly once even under
contention. Rules are managed at `GET/POST /api/admin/upgrade/rules`, `PUT/DELETE …/rules/:id`.

## Propagating decisions across instances

A decision made once on staging shouldn't be re-made by hand on production. **Resolution bundles** carry the
triage across instances: `POST /api/admin/upgrade/resolutions/export` emits a **signed** record of every
resolved item — its `(family, logical_key, remote_hash)` key and the decision — and
`POST /api/admin/upgrade/resolutions/import` verifies and replays it.

Import is deliberately conservative:

- **Signature first.** The bundle is signed with the same Ed25519 construction the release manifest uses; a
  bad or untrusted signature applies **nothing**. Production trusts staging's public key via
  `GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS`; the signing key comes from `GENEWEAVE_UPGRADE_SIGNING_KEY` (or a
  vault credential id).
- **Matched on the full triple.** A decision only resolves a local item whose `(family, logical_key,
  remote_hash)` matches *exactly*. If production shipped **different content** for that key (a different
  `remote_hash`), the entry is **skipped**, never blindly adopted — the staging decision was about different
  bytes. Applied resolutions are stamped `resolution_source = 'imported'`.
- **P1 still refused**, and a cross-edition bundle is rejected.

## The application-code layer (L2)

A running instance can't hot-swap its own source — new code arrives by deploy. But it *can* tell you what you've
changed and what a release changes, so you never lose an edit across an upgrade. That's the L2 code layer.

Identity is a **source baseline**: a manifest of every source file's path → SRI hash, captured at install/upgrade
time (`POST /api/admin/upgrade/code/baseline`). It's git-free — a non-git deploy gets the same three-way answer
git would give. A first-line **provenance pragma** (`// @geneweave-provenance …`) is excluded from the hash, so
stamping a file with where it came from never reads as an edit.

**`code status`** (`GET /api/admin/upgrade/code/status`) hashes the live tree and classifies each file against
the baseline (and, at upgrade time, the release's target): *unchanged · operator-modified · vendor-updated ·
both-changed · added · removed · orphaned* (a file the release deletes that you'd edited — never auto-removed).
A **`code scan`** (`POST /api/admin/upgrade/code/scan`) records those changes as L2 items in the **same review
queue** as content, so code gets keep/defer/bulk with the identical guardrails — a both-changed **conflict is
P1** and is never bulk-resolved. (`adopt` is refused for code: taking the upstream is a deploy, not an in-app
write.)

For a both-changed file the engine runs a line-level **diff3 merge**: non-overlapping edits merge cleanly;
overlapping edits produce standard `<<<<<<< ||||||| ======= >>>>>>>` markers to resolve in any editor or
mergetool — the git-native path.

**Scanning without a local git checkout.** The three-way scan needs the release's *pristine* source at your
installed version (BASE) and the target version (REMOTE). If your instance was installed from a git clone, those
come from local tags. If it wasn't — a source download, or a clone missing the tags — the Upgrade Center fetches
them straight from the configured GitHub repo as **tarballs** (`POST /api/admin/upgrade/code/scan-remote`, which
the "Scan release" button falls back to automatically when local git is unavailable). The download goes through
the same hardened HTTP pipeline as the manifest (a private-repo token rides only in the `Authorization` header,
never logged), and the fetched target tree is **integrity-checked against the signed manifest's
`fileManifestDigest`** before a single conflict is recorded — a tampered or wrong tree is rejected, not merged.
Extraction is size-capped and path-traversal-safe, and the temporary trees are always removed. The result feeds
the *same* classifier, so "auto-adopt what I haven't touched, flag what I changed" works with no git at all.

The walk is confined to the tree root and never follows a symlink, so a hostile baseline can't read outside the
scan root. **Scale:** hashing a 10,000-file tree takes ~0.2 s; the review resolution path sustains ~30k
resolves/s with 1,000 concurrent resolves finishing in tens of milliseconds (p99 ≈ 31 ms) with no lost updates,
and concurrent resolves of the same item are idempotent.

### Resolving code conflicts

There are two ways to resolve a both-changed file, matching the two editions:

- **Git round-trip (Community).** The engine writes the conflict-marked files onto a fresh `upgrade/v<target>`
  git branch; you resolve them in any editor, mergetool, or PR — nothing geneWeave-specific — and the engine
  imports the resolved content back. A file that still carries conflict markers on the branch keeps L3 blocked.
- **Patch reapply (Private/locked).** The vendor tree is swapped wholesale, and your customizations live as
  sanctioned patch files that reapply on top of the new tree. Reapply is a real three-way merge (baseline, your
  edit, new vendor), so a patch whose lines the vendor also changed becomes a conflict in the review queue (a
  P1) — never silently dropped, and your edit is never silently lost.

**In-app merge editor.** The Upgrade Center's **Code** section resolves a conflict without leaving the app.
*Scan release* runs a three-way scan of the live tree against the accepted release's git refs (BASE = the
installed tag, REMOTE = the release's `repoTag`) and records every genuine both-changed file as a `family='code'`
conflict (P1). Opening one shows a two-pane split (a bundled `@codemirror/merge` view modeled on the merge
editors operators expect): the **incoming release version on the left** (read-only) and the **base-informed
diff3 pre-merge on the right** (editable) — clean hunks already applied, only true conflicts left as markers.
Per-chunk **accept-incoming** arrows copy the release's version in without retyping, unchanged stretches are
collapsed, a live counter shows how many conflicts remain, **Next conflict** jumps between them, and *Apply
resolution* stays disabled until every marker is gone. Apply writes the resolution to the working tree and the
server **refuses** any text still carrying conflict markers (so it can never clear the L3 gate for a
still-conflicted file). The three text sides are sourced from git (LOCAL on disk; BASE/REMOTE at the two refs),
so the in-app editor works on a **Community git install**; where those refs aren't available (a non-git deploy,
or no accepted release yet) it says so and points you at the git branch above.
Set `GENEWEAVE_SOURCE_BASE_REF` if the installed code's tag isn't `v<version>`.

## Safety: the migration ledger and pre-upgrade snapshots

- **Migration ledger.** Schema migrations are recorded in a `schema_migrations` ledger as they apply, keyed
  by id and content hash. A migration runs once; the next startup skips it. A migration whose definition
  changes (a new hash) re-runs. Normal startup stays lenient (it tolerates already-applied statements); an
  upgrade run uses strict mode so a failing statement aborts the upgrade instead of silently half-applying.
- **Snapshots.** Before an upgrade mutates anything, the database is snapshotted — for SQLite a
  WAL-checkpointed file copy (near-free), for Postgres a `pg_dump` — so a failed upgrade restores cleanly to
  where you were.

## Pruning the version log

Every published default lands one immutable row in `realm_versions` (the drift Base/Remote payloads live
here). Content-addressing keeps it deduped, but a long-lived instance still accumulates historical payloads for
records nobody references any more. `POST /api/admin/upgrade/prune-versions` garbage-collects that tail — and it
is deliberately conservative about what it keeps. A version is deleted only if it is in **none** of these:

- **the head window** — the newest `keepPerKey` versions per record (default 10); the head is the Remote leg
  every drift/diff/reconcile reads, so it is never deletable;
- **live-referenced** — any version whose `content_hash` a live row still points at via its `origin_hash`
  (the Base it was forked/baselined from) or current `content_hash`;
- **pinned** — any version a tenant has pinned (`realm_tenant_state.pinned_version`); deleting a pinned version
  would silently drop that tenant back to the current default, exactly what the pin exists to prevent.

Pass `{ dryRun: true }` to see the plan (how many *would* be pruned) without deleting, `{ family }` to scope to
one family, `{ keepPerKey }` to tune retention. It is idempotent and dialect-neutral. **Scale:** pruning a
10,000-version log completes in tens of milliseconds (~400k rows/s); it processes one family at a time, so peak
memory is bounded by a single family's version rows, not the whole log.

## Telemetry (opt-out)

geneWeave records telemetry **locally** — LLM run traces (`traces`/`metrics`) and a light, PII-free stream of
upgrade-lifecycle events (`upgrade_telemetry`: event, outcome, edition, dialect, versions, aggregate counts —
no user id, key, path, or payload). **Nothing is phoned home**; data stays in this instance's own database, and
only reaches a collector if *you* set `OTEL_EXPORTER_OTLP_ENDPOINT`. Because nothing leaves the box by default,
there is no cross-border transfer and no consent flow to manage.

To turn telemetry off entirely, set `GENEWEAVE_TELEMETRY=0` (also `false`/`off`/`no`) or the cross-vendor
`DO_NOT_TRACK=1`. When opted out, both the run-trace recorder and the upgrade emitter become no-ops — nothing is
recorded. Read the recent upgrade events at `GET /api/admin/upgrade/telemetry`.

## Both engines, one implementation

Everything above is written once against the framework's SQL seam and runs identically on **SQLite** and
**Postgres**. The reconcile, the ledger tables, the run/detail persistence, and the priority scoring are
dialect-neutral; only the snapshot maker is engine-specific by nature.

## Configuration

There's nothing to turn on — reconcile-on-startup is simply how the system works. The environment flags you
already know still apply and are respected by the reconcile:

| variable | effect |
|---|---|
| `GENEWEAVE_ENABLE_LLM_JUDGES=1` | enable the heavier LLM-judge guardrails on a fresh install |
| `GENEWEAVE_UPGRADE_SIGNING_KEY` (or `…_CREDENTIAL_ID`) | Ed25519 private key (PEM / vault credential id) that signs exported resolution bundles; absent ⇒ export disabled |
| `GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS` | PEM bundle of public keys whose signature an *imported* resolution bundle is trusted under; absent ⇒ import disabled |
| `GENEWEAVE_EDITION` | the instance edition, stamped on exported bundles and checked on import (default `community`) |
| `GENEWEAVE_TELEMETRY=0` / `DO_NOT_TRACK=1` | opt out of ALL local telemetry (run traces + upgrade-lifecycle events); default is on/local-only |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | when set, telemetry is also exported to your own OpenTelemetry collector (unset ⇒ local only) |
| `GENEWEAVE_SOURCE_ROOT` | the source/git work-tree root the L2 code scan + in-app merge operate on (defaults to the package dir) |
| `GENEWEAVE_SOURCE_BASE_REF` | the installed code's git ref for the in-app merge's BASE side (defaults to `v<installed version>`) |

For the operator, publisher, and private-edition runbooks see [`RUNBOOKS.md`](RUNBOOKS.md); for the update-
security threat model (and its TUF mapping) see [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Where it lives (for contributors)

| concern | module |
|---|---|
| registry-wide reconcile | `apps/geneweave/src/realm-seed-reconcile.ts` |
| shipped defaults per family | `apps/geneweave/src/realm-seed-defaults.ts` |
| run / detail persistence | `apps/geneweave/src/upgrade-run-store.ts` |
| priority policy (family → band) | `apps/geneweave/src/upgrade-priority.ts` — wraps `bandFor` from `@weaveintel/upgrade` |
| pre-upgrade snapshots | `apps/geneweave/src/upgrade-snapshot.ts` — re-exports from `@weaveintel/upgrade` |
| release discovery + check | `apps/geneweave/src/upgrade-check.ts` — composes `@weaveintel/upgrade`'s `UpdateChecker` + resilient HTTP + vault token |
| release audit + anti-rollback floor | `apps/geneweave/src/upgrade-release-store.ts`; `migrations/m169-upgrade-releases.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |
| preflight gates | `apps/geneweave/src/upgrade-preflight.ts` |
| read-only four-layer preview | `apps/geneweave/src/upgrade-preview.ts` — classifies via `@weaveintel/realm`'s `classifyDrift`, reusing the reconcile's live-row hashing |
| apply orchestration (L1→L4, snapshot/rollback, resume, deferral) | `apps/geneweave/src/upgrade-apply.ts` |
| post-apply verify (readiness + invariants + `@upgrade-critical` hook) | `apps/geneweave/src/upgrade-verify.ts` |
| manual rollback (`rollback --run <id>`) | `apps/geneweave/src/upgrade-rollback.ts`; retained-snapshot column `migrations/m172-upgrade-snapshot-ref.ts` |
| review queue engine (keep/adopt/defer/bulk/undo) | `apps/geneweave/src/upgrade-review.ts`; undo-snapshot column `migrations/m173-upgrade-detail-undo.ts` |
| needs-attention report (drift + version lag) | `apps/geneweave/src/upgrade-attention.ts` |
| L2 code baselines + scanner + diff3 merge | `apps/geneweave/src/source-baselines.ts`, `code-scan.ts` (uses `node-diff3`) |
| L2 code baseline store + scan orchestration | `apps/geneweave/src/code-baseline-store.ts`; baseline table `migrations/m174-upgrade-code-baseline.ts` |
| L2 git round-trip (checkout/import) + ref reads | `apps/geneweave/src/code-git.ts` |
| L2 in-app merge backend (git-sourced 3 sides + resolve) | `apps/geneweave/src/code-merge.ts` |
| L2 release-aware scan (produces real conflicts from git refs) | `apps/geneweave/src/code-release-scan.ts` (`baselineAtRef` + `scanCodeAgainstRelease`); git tree reads in `code-git.ts` |
| L2 in-app merge editor (bundled `@codemirror/merge`) | `apps/geneweave-ui/src/ui/code-merge-editor.ts` + `codemirror-merge-bundle-entry.ts` + `scripts/bundle-codemirror-merge.mjs`; Code section in `ui/upgrade-center-ui.ts` |
| L2 Private patch reapply | `apps/geneweave/src/code-patch.ts` |
| queue automation (resolution rules) + per-family policy rows | `apps/geneweave/src/upgrade-automation.ts`; tables + `resolution_source` column `migrations/m175-upgrade-automation.ts`; both registered in `realm-families.ts` |
| signed resolution bundles (export/import) | `apps/geneweave/src/upgrade-bundle.ts` — reuses `signManifest`/`createEd25519Verifier` from `@weaveintel/upgrade` |
| version-log retention pruning (respects head/refs/pins) | `apps/geneweave/src/realm-version-prune.ts` |
| telemetry opt-out gate + local upgrade telemetry | `apps/geneweave/src/telemetry-config.ts`, `upgrade-telemetry.ts`; table `migrations/m176-upgrade-telemetry.ts`; run-trace guard in `chat-trace-utils.ts` |
| per-node workflow merge | `apps/geneweave/src/workflow-merge.ts`, wired into `realm-diff.ts` (`applyRealmMerge`/`loadThreeWayDiff`) |
| Upgrade Center screen | `apps/geneweave-ui/src/ui/upgrade-center-ui.ts` (customView `upgrade-center`); composes `realm-ui.ts` badges + diff |
| advisory mutex | `apps/geneweave/src/upgrade-lock-store.ts`; `migrations/m170-upgrade-lock.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |
| maintenance flag | `apps/geneweave/src/upgrade-maintenance.ts`; `migrations/m171-upgrade-maintenance.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |
| strict/ledgered L3 run (deferral-aware) | `runUpgradeMigrations` in `apps/geneweave/src/migrations/index.ts` |
| pre-upgrade snapshot + restore | `apps/geneweave/src/upgrade-snapshot.ts` — re-exports `snapshotSqliteFile`/`snapshotPgDump` from `@weaveintel/upgrade` |
| admin check/status/preflight/preview/apply/rollback routes | `apps/geneweave/src/admin/api/upgrade.ts` |
| workflow node/edge merge | `apps/geneweave/src/workflow-merge.ts` — wraps `mergeKeyedList` from `@weaveintel/upgrade` |
| migration ledger + strict mode | `apps/geneweave/src/migrations/helpers.ts` |
| ledger + run tables | `apps/geneweave/src/migrations/m163-upgrade-ledger.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |

The engine-generic primitives — priority banding, pre-upgrade snapshots, and the structured id-keyed merge
— live in the framework package **`@weaveintel/upgrade`**; the app supplies the policy (which family maps to
which band, which fields are id-keyed lists). The reconcile itself is driven by the realm family registry
(`realm-families.ts`): a family is covered for full stale-adoption as soon as its shipped defaults are listed
in `realm-seed-defaults.ts`; every registered family is kept drift-ready with baselines regardless.
