// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — PREFLIGHT: the read-only gate an operator runs before applying a release.
 *
 * Preflight answers one question — "is it safe to apply this release right now?" — WITHOUT changing anything.
 * It runs five independent gates and reports each with a pass/fail and a human reason, so an operator can fix
 * problems during a maintenance window instead of discovering them mid-upgrade (the industry-standard reason
 * to run preflight checks early and independently of the actual upgrade):
 *
 *   1. packages   (L1) — every platform package the release REQUIRES is installed at a satisfying version;
 *                        names any that are stale/missing (an apply on old library code would misbehave).
 *   2. mutex           — no other upgrade operation is currently holding the instance lock.
 *   3. disk            — enough free space on the database's volume for the pre-upgrade snapshot (SQLite only;
 *                        a managed Postgres server's disk isn't observable from here, so it's reported skipped).
 *   4. unresolved_p1   — no P1 review item from a prior run is still open (P1s must be cleared first).
 *   5. edition         — the release targets THIS instance's edition.
 *
 * Every gate is a SELECT / filesystem read / lock read — preflight never writes. The inputs (installed-version
 * reader, disk-free probe, clock) are injectable so tests are deterministic and hermetic.
 */
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { satisfies as semverSatisfies, valid as semverValid } from 'semver';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import type { UpgradeManifest } from '@weaveintel/upgrade';
import { upgradeLockState } from './upgrade-lock-store.js';

/** One gate's outcome. `data` carries the structured detail (e.g. the stale-package list) for the UI/JSON. */
export interface PreflightGate {
  readonly name: 'packages' | 'mutex' | 'disk' | 'unresolved_p1' | 'edition';
  readonly ok: boolean;
  readonly detail: string;
  readonly data?: unknown;
}

/** The whole preflight verdict: OK iff every gate passed. */
export interface PreflightResult {
  readonly ok: boolean;
  readonly version: string;
  readonly edition: string;
  readonly gates: PreflightGate[];
}

/** A package whose installed version doesn't satisfy the range the release requires. */
export interface StalePackage {
  readonly name: string;
  readonly installed: string | null; // null = not installed at all
  readonly required: string;
}

/** Everything preflight needs — injectable so tests supply hermetic readers. */
export interface PreflightConfig {
  /** The release manifest being gated (from `latestAcceptedManifest`). */
  readonly manifest: UpgradeManifest;
  /** This instance's edition. */
  readonly edition: string;
  /** The installed application version (context only; the anti-rollback check lives in the `check` command). */
  readonly installedVersion: string;
  /** The SQLite database file path, for the disk-headroom probe; null/undefined for Postgres (skipped). */
  readonly dbPath?: string | null;
  /** Minimum free bytes required on the DB volume (default 100 MiB). */
  readonly minFreeBytes?: number;
  /** Read an installed package's version (default: read `node_modules/<name>/package.json`). Tests override. */
  readonly readInstalledPackageVersion?: (name: string) => string | null;
  /** Probe free bytes on the volume holding `path` (default: `statfs`). Returns null if unobservable. */
  readonly diskFree?: (path: string) => Promise<number | null>;
}

const DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** The application root (one level up from this `src` module) — where `node_modules` lives. */
function appRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Default installed-version reader: `node_modules/<name>/package.json`'s `version`, or null if not installed.
 * @param name the (possibly scoped) package name.
 * @returns the installed version string, or null.
 */
function defaultReadInstalledVersion(name: string): string | null {
  try {
    const pkgPath = join(appRoot(), 'node_modules', ...name.split('/'), 'package.json');
    const v = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

/** Default disk-free probe via `statfs`; returns available bytes, or null when it can't be determined. */
async function defaultDiskFree(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * The default installed-version reader (exported so the preview's L1 layer uses the same probe as preflight).
 */
export const readInstalledPackageVersion = defaultReadInstalledVersion;

/**
 * Compute the L1 "stale package" set: every package the release REQUIRES a range of whose installed version is
 * missing or doesn't satisfy that range. Shared by preflight's package gate and the preview's L1 layer so the
 * two never disagree.
 * @param manifest the release manifest (its `layers.packages`).
 * @param read the installed-version reader (defaults to the node_modules probe).
 * @returns `{ stale, checked }` — the unsatisfied packages and how many required a check.
 */
export function stalePackages(
  manifest: UpgradeManifest,
  read: (name: string) => string | null = defaultReadInstalledVersion,
): { stale: StalePackage[]; checked: number } {
  const stale: StalePackage[] = [];
  let checked = 0;
  for (const p of manifest.layers.packages) {
    if (!p.requires) continue; // no required range → nothing to gate on (informational pin only)
    checked++;
    const installed = read(p.name);
    // Missing, or present but not satisfying the required range (invalid installed versions count as stale).
    if (!installed || !semverValid(installed) || !semverSatisfies(installed, p.requires, { includePrerelease: true })) {
      stale.push({ name: p.name, installed, required: p.requires });
    }
  }
  return { stale, checked };
}

/**
 * The L1 package gate: for every package the release REQUIRES a range of, confirm the installed version
 * satisfies it. This is the arborist-style "is the code layer in place?" check — content/schema shipped by a
 * release assume the matching library code, so a stale package is a hard blocker.
 * @param manifest the release manifest (its `layers.packages`).
 * @param read the installed-version reader.
 * @returns the gate outcome; `data.stale` names every unsatisfied/missing package.
 */
function packageGate(manifest: UpgradeManifest, read: (name: string) => string | null): PreflightGate {
  const { stale, checked } = stalePackages(manifest, read);
  return {
    name: 'packages',
    ok: stale.length === 0,
    detail: stale.length === 0
      ? `all ${checked} required package(s) satisfied`
      : `${stale.length} package(s) need upgrading first: ${stale.map((s) => s.name).join(', ')}`,
    data: { stale, checked },
  };
}

/**
 * The mutex gate: report whether another upgrade operation currently holds the instance lock. Read-only — it
 * does NOT acquire the lock (the apply path does that); it only surfaces contention so preflight can warn.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the gate outcome; OK iff the lock is free.
 */
async function mutexGate(client: SqlClient, dialect: SqlDialect): Promise<PreflightGate> {
  const state = await upgradeLockState(client, dialect);
  return {
    name: 'mutex',
    ok: state.holder === null,
    detail: state.holder === null ? 'no upgrade in progress' : `an upgrade is already in progress (since ${state.acquiredAt ?? 'unknown'})`,
    data: { holder: state.holder, acquiredAt: state.acquiredAt },
  };
}

/**
 * The disk gate: enough free space on the DB volume for the pre-upgrade snapshot. Only meaningful for a local
 * SQLite file — a managed Postgres server's disk isn't observable from the app, so it's reported OK+skipped.
 * @param config preflight config (dbPath, minFreeBytes, diskFree probe).
 * @returns the gate outcome.
 */
async function diskGate(config: PreflightConfig): Promise<PreflightGate> {
  if (!config.dbPath) {
    return { name: 'disk', ok: true, detail: 'skipped (external/managed database volume not observable)', data: { skipped: true } };
  }
  const min = config.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const probe = config.diskFree ?? defaultDiskFree;
  const free = await probe(dirname(config.dbPath));
  if (free === null) {
    return { name: 'disk', ok: true, detail: 'free space could not be determined (probe unavailable)', data: { free: null, min } };
  }
  return {
    name: 'disk',
    ok: free >= min,
    detail: free >= min ? `${Math.floor(free / 1e6)} MB free (need ${Math.floor(min / 1e6)} MB)` : `only ${Math.floor(free / 1e6)} MB free; need at least ${Math.floor(min / 1e6)} MB`,
    data: { free, min },
  };
}

/**
 * The unresolved-P1 gate: no P1 review item from a prior run may still be open. P1s (guardrails and any genuine
 * both-sides conflict) are never auto-resolved, so a pending one must be cleared before a new upgrade piles on.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the gate outcome; OK iff the open-P1 count is zero.
 */
async function unresolvedP1Gate(client: SqlClient, dialect: SqlDialect): Promise<PreflightGate> {
  void dialect;
  const { rows } = await client.query(`SELECT count(*) AS c FROM upgrade_details WHERE priority = 'P1' AND resolution IS NULL`);
  const count = Number((rows[0] as { c?: number | string })?.c ?? 0);
  return {
    name: 'unresolved_p1',
    ok: count === 0,
    detail: count === 0 ? 'no open P1 review items' : `${count} open P1 review item(s) must be resolved first`,
    data: { count },
  };
}

/**
 * The edition gate: the release must target this instance's edition (a belt-and-braces re-check — the `check`
 * command already rejects a wrong-edition manifest, but preflight verifies against the stored manifest too).
 * @param manifest the release manifest.
 * @param edition this instance's edition.
 * @returns the gate outcome.
 */
function editionGate(manifest: UpgradeManifest, edition: string): PreflightGate {
  const ok = manifest.edition === edition;
  return {
    name: 'edition',
    ok,
    detail: ok ? `release edition '${manifest.edition}' matches` : `release is for edition '${manifest.edition}', this instance is '${edition}'`,
    data: { manifestEdition: manifest.edition, instanceEdition: edition },
  };
}

/**
 * Run all preflight gates against a release manifest. Purely read-only — SELECTs, a lock read, filesystem
 * probes; no writes.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param config the manifest + edition + injectable probes.
 * @returns the overall verdict (`ok` iff every gate passed) and the per-gate detail.
 */
export async function runPreflight(client: SqlClient, dialect: SqlDialect, config: PreflightConfig): Promise<PreflightResult> {
  const read = config.readInstalledPackageVersion ?? defaultReadInstalledVersion;
  const gates: PreflightGate[] = [
    packageGate(config.manifest, read),
    await mutexGate(client, dialect),
    await diskGate(config),
    await unresolvedP1Gate(client, dialect),
    editionGate(config.manifest, config.edition),
  ];
  return { ok: gates.every((g) => g.ok), version: config.manifest.version, edition: config.edition, gates };
}
