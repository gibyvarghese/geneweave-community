# geneWeave Upgrade Engine — Threat Model

The upgrade engine downloads code, schema, and data changes from a remote source and applies them to a running
instance. That makes it a high-value target: an attacker who can get a malicious "update" applied owns the
instance. This document states what the engine defends against, how, and where the seams for stronger defenses
are.

The framing follows **The Update Framework (TUF)** — the CNCF-graduated standard for secure software updates —
which enumerates the canonical attacks on an update system. For each, we state geneWeave's current defense and
the residual risk.

## Trust model

- **Releases are signed.** A release is a `manifest.json` carrying a detached **Ed25519** signature over the
  canonical (RFC-8785-style) JSON of its body. The client accepts it only if the signing key's fingerprint is
  in the client's **trust set** (`GENEWEAVE_UPGRADE_TRUSTED_KEYS`, a PEM bundle) *and* the bytes verify. A
  manifest carrying its own key cannot self-authorize.
- **The signing key is offline.** The private key lives with the publisher and never ships to instances. Key
  rotation = distributing a new public key (a new verifier).
- **Verification is behind an interface.** `SignatureVerifier` (`verify(body, signature) → { ok, reason }`) is
  the single seam every trust decision flows through — the documented drop-in point for a TUF-backed verifier.

## Attack-class coverage (TUF)

| TUF attack | What it is | Defense in geneWeave | Residual risk |
|---|---|---|---|
| **Arbitrary software installation** | attacker serves a malicious manifest/artifact | Ed25519 signature over the whole manifest body against a fixed trust set; artifact bytes checked with `ssri` integrity (`computeIntegrity`/`verifyIntegrity`) | a compromised *offline signing key* — mitigated by keeping it offline; TUF thresholds are the roadmap (below) |
| **Rollback attack** | serve an older, vulnerable-but-validly-signed version | anti-rollback **floor** = max version among *accepted* releases; a lower version is rejected `downgrade`. Only fully-verified releases raise the floor. | none for versions below the floor; a first-ever install has no floor yet (trust-on-first-use) |
| **Freeze attack** | keep serving the same (old) manifest so the client never sees updates | manifests carry `expiresAt`; an expired manifest is rejected `expired` (clock-injectable for testing) | requires publishers to set + refresh `expiresAt`; without it, freeze is only bounded by the rollback floor |
| **Mix-and-match attack** | combine artifacts from different releases | one signature covers the **entire** manifest (all layers: packages, code, schema, content) — you cannot swap one layer's entry without breaking the signature | none within a manifest; cross-manifest mixing is blocked by the single-manifest apply |
| **Wrong-edition / entitlement** | apply a release meant for another edition | manifest declares `edition`; preflight refuses a mismatch (`edition_mismatch`); enterprise entitlement checks slot into the same gate | operator misconfiguring `GENEWEAVE_EDITION` |
| **Endless-data / resource attack** | oversized artifact exhausts the client | preflight disk-headroom gate; snapshot-before-apply bounds blast radius | no hard size cap on the manifest fetch yet (roadmap) |
| **Malicious mirror / MITM** | tamper with bytes in transit | all release HTTP flows through the resilience layer (TLS); the signature makes transit integrity moot — tampered bytes fail `bad_signature` | — |

## Defense-in-depth beyond signing

- **Snapshot + auto-rollback.** Every apply snapshots the DB first (SQLite WAL copy / Postgres `pg_dump`) and
  restores automatically on any L3/verify failure — a bad-but-signed release cannot leave a half-applied state.
- **Strict, ledgered migrations.** Schema changes run in a `schema_migrations` ledger in strict mode during an
  upgrade: a failing statement aborts and rolls back rather than silently half-applying. Re-runs skip completed
  batches (crash-safe).
- **Never destroys tenant/operator work.** Reconcile hashes the live row, so an operator edit is always seen and
  kept+flagged, never overwritten; tenant forks and pins are preserved byte-for-byte across an apply. The
  version-log pruner explicitly refuses to delete a pinned or live-referenced payload.
- **Least-privilege secrets.** The private-repo token and the bundle signing key are read from the encrypted
  credential vault (by credential id), decrypted per-call, never logged, never in error messages. Plaintext env
  vars exist only as a dev fallback.
- **Automation can't escalate.** Resolution rules and imported resolution bundles **never** auto-resolve a P1
  (guardrail/collision/conflict); rule and policy changes flow through the realm propose→review→promote
  dual-control.
- **Local-only telemetry.** Telemetry is recorded locally and is PII-free; nothing is phoned home, and it is
  opt-out (`DO_NOT_TRACK` / `GENEWEAVE_TELEMETRY`).

## Hardening roadmap — full TUF

The current design is single-root Ed25519 with an offline key. The `SignatureVerifier` seam is where the full
TUF role model drops in when broad distribution warrants it:

- **Role separation + thresholds.** TUF's `root` / `targets` / `snapshot` / `timestamp` roles, each with its own
  key(s) and a **threshold** of required signatures, so no single compromised key can forge a release. A
  `tuf-js`-backed verifier implements this behind the existing interface with no client-call-site changes.
- **Timestamp role** gives a stronger, automatically-refreshed freshness guarantee than a static `expiresAt`.
- **Key rotation via the root role** replaces the manual "distribute a new public key" step.

Until then, the practical guidance is: **keep the signing key offline, set `expiresAt` on every release, and
distribute trusted public keys out-of-band.**
