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

## Structured fields (workflows)

Most built-ins are flat records, and the reconcile compares them field by field. A workflow is different:
its `steps` is a graph of nodes, each carrying its own wiring. Treating that as one atomic value would make
a release adding a node conflict with a tenant re-wiring a *different* node. So the merge for workflows is
**per node**: a node the tenant never touched that the release changed is upgraded; a node the tenant
customised is kept; a node either side *added* coexists; only a node both sides changed differently is a
conflict — and even then the tenant's version is kept and flagged, never lost. The same three-way logic,
applied to each node instead of the whole field.

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

Enable it with these environment variables (unset = the command reports `not_configured` and does nothing):

| variable | meaning |
|---|---|
| `GENEWEAVE_UPGRADE_REPO` | the `owner/repo` GitHub releases are published to |
| `GENEWEAVE_UPGRADE_TRUSTED_KEYS` | a PEM bundle of the Ed25519 public keys you trust to sign releases |
| `GENEWEAVE_EDITION` | this instance's edition (default `community`) |
| `GENEWEAVE_UPGRADE_ASSET` | the manifest asset's file name (default `manifest.json`) |
| `GENEWEAVE_UPGRADE_TOKEN` / `GENEWEAVE_UPGRADE_TOKEN_CREDENTIAL_ID` | a bearer token for a **private** release repo — a vault credential id (preferred) or a plain token; used only in the `Authorization` header, never logged |

The signing/verification, manifest schema, and release sources are the brand-neutral
[`@weaveintel/upgrade`](https://www.npmjs.com/package/@weaveintel/upgrade) package; geneWeave supplies the
persistence, the resilient HTTP, and the admin route.

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

## Safety: the migration ledger and pre-upgrade snapshots

- **Migration ledger.** Schema migrations are recorded in a `schema_migrations` ledger as they apply, keyed
  by id and content hash. A migration runs once; the next startup skips it. A migration whose definition
  changes (a new hash) re-runs. Normal startup stays lenient (it tolerates already-applied statements); an
  upgrade run uses strict mode so a failing statement aborts the upgrade instead of silently half-applying.
- **Snapshots.** Before an upgrade mutates anything, the database is snapshotted — for SQLite a
  WAL-checkpointed file copy (near-free), for Postgres a `pg_dump` — so a failed upgrade restores cleanly to
  where you were.

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
| advisory mutex | `apps/geneweave/src/upgrade-lock-store.ts`; `migrations/m170-upgrade-lock.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |
| maintenance flag | `apps/geneweave/src/upgrade-maintenance.ts`; `migrations/m171-upgrade-maintenance.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |
| strict/ledgered L3 run (deferral-aware) | `runUpgradeMigrations` in `apps/geneweave/src/migrations/index.ts` |
| pre-upgrade snapshot + restore | `apps/geneweave/src/upgrade-snapshot.ts` — re-exports `snapshotSqliteFile`/`snapshotPgDump` from `@weaveintel/upgrade` |
| admin check/status/preflight/preview/apply routes | `apps/geneweave/src/admin/api/upgrade.ts` |
| workflow node/edge merge | `apps/geneweave/src/workflow-merge.ts` — wraps `mergeKeyedList` from `@weaveintel/upgrade` |
| migration ledger + strict mode | `apps/geneweave/src/migrations/helpers.ts` |
| ledger + run tables | `apps/geneweave/src/migrations/m163-upgrade-ledger.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |

The engine-generic primitives — priority banding, pre-upgrade snapshots, and the structured id-keyed merge
— live in the framework package **`@weaveintel/upgrade`**; the app supplies the policy (which family maps to
which band, which fields are id-keyed lists). The reconcile itself is driven by the realm family registry
(`realm-families.ts`): a family is covered for full stale-adoption as soon as its shipped defaults are listed
in `realm-seed-defaults.ts`; every registered family is kept drift-ready with baselines regardless.
