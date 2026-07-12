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
| workflow node/edge merge | `apps/geneweave/src/workflow-merge.ts` — wraps `mergeKeyedList` from `@weaveintel/upgrade` |
| migration ledger + strict mode | `apps/geneweave/src/migrations/helpers.ts` |
| ledger + run tables | `apps/geneweave/src/migrations/m163-upgrade-ledger.ts` (SQLite); `db-postgres-schema.ts` (Postgres) |

The engine-generic primitives — priority banding, pre-upgrade snapshots, and the structured id-keyed merge
— live in the framework package **`@weaveintel/upgrade`**; the app supplies the policy (which family maps to
which band, which fields are id-keyed lists). The reconcile itself is driven by the realm family registry
(`realm-families.ts`): a family is covered for full stale-adoption as soon as its shipped defaults are listed
in `realm-seed-defaults.ts`; every registered family is kept drift-ready with baselines regardless.
