# Changelog

All notable changes to the geneWeave application are documented here. The project follows
[Semantic Versioning](https://semver.org/) with a fabric codename on majors — see [`VERSIONING.md`](VERSIONING.md).
Both editions (community + private) share the same version line. Releases are cut as signed manifests (see
[`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) → *Publisher runbook*), and the running engine verifies, applies, and
reconciles them (see [`docs/UPGRADE_ENGINE.md`](docs/UPGRADE_ENGINE.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

_Nothing yet._

## [1.0.0] — Aertex

The Upgrade Engine — geneWeave keeps itself, its schema, and its shipped defaults current across releases the
way a good package manager handles config files: it never clobbers your edits and never strands you on an old
default.

### Discovery & safety
- **Signed release discovery** — poll a GitHub Release source, verify an Ed25519-signed manifest, and reject a
  tampered (`bad_signature`), untrusted (`untrusted_key`), expired (`expired`), downgrade (`downgrade`), or
  wrong-edition (`edition_mismatch`) release, each with a distinct reason.
- **Preflight + read-only preview** — package/disk/lock/entitlement gates and a four-layer plan that mutates
  nothing.
- **Apply with auto-rollback** — snapshot first (SQLite WAL copy / Postgres `pg_dump`), run L1→L4 under
  maintenance mode, verify, and restore automatically on failure. Crash-resumable (ledgered schema +
  content-addressed data converge without double-applying).

### Reconcile & review
- **Startup reconcile** for every built-in family — adopt untouched improvements, keep + flag your
  customizations, surface genuine conflicts in a prioritized review queue (guardrails first; P1 never
  auto/bulk-resolved).
- **Field-level three-way merge** for records, **per-node** merge for workflows, and a keyboard-driven Upgrade
  Center with per-action undo.
- **Per-family adoption policy** (`always` / `patch_only` / `never`), overridable as governed config rows.

### Application code (L2)
- **Community** — git-native B/L/R classification, diff3 auto-merge, and conflicts written to an
  `upgrade/v<target>` branch resolvable in any editor/mergetool/PR.
- **Private** — locked whole-tree swap with sanctioned patch reapplication; a patch that no longer applies
  enters the queue as a P1.

### Automation & propagation
- **Resolution rules** — automate the safe parts of the queue by family/priority/disposition (keep/adopt/defer/
  tag), first-match-wins, **never** auto-resolving a P1.
- **Signed resolution bundles** — export triage decisions from one instance and replay them on another, matched
  on `(family, logical_key, remote_hash)`, skipping any non-matching shipped content.

### Hardening
- **Version-log pruning** that always keeps the head, every live-referenced Base, and every tenant-pinned
  version.
- **Local, opt-out telemetry** — PII-free upgrade-lifecycle events recorded locally; nothing phoned home; off
  via `GENEWEAVE_TELEMETRY=0` / `DO_NOT_TRACK=1`.
- **Multi-tenancy realm** — per-tenant forks, pins, drift, and propose→review→promote governance underpin all of
  the above; a change to a rule or policy flows through the same dual-control.

Runs identically on **SQLite** and **Postgres**. Operator, publisher, and private-edition procedures are in
[`docs/RUNBOOKS.md`](docs/RUNBOOKS.md); the update-security posture (and its TUF mapping) is in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
