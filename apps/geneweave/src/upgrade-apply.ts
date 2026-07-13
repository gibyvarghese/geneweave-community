// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — APPLY orchestration.
 *
 * Apply is the mutating step of the upgrade flow. It runs the four layers in order (L1 → L2 → L3 → L4), each
 * gating the next, under a mutex + a pre-upgrade snapshot so a failure restores cleanly. It composes existing
 * machinery rather than reinventing it: the Phase-2 mutex (`upgrade-lock-store`), preflight gate
 * (`upgrade-preflight`), the strict/ledgered migration runner (`runUpgradeMigrations` — L3), the registry
 * reconcile (`reconcileAllRealmFamilies` — L4), the pre-upgrade snapshot (`upgrade-snapshot`), and the
 * run/detail persistence (`upgrade-run-store`).
 *
 * The L1/L2 boundary is deliberate. A running server cannot npm-install and hot-swap its own dependencies
 * (L1) or git-merge and typecheck its own source tree (L2) — those are deploy/CI operations that produce the
 * artifact the server then runs. Preflight already verifies the required packages are present; apply therefore
 * *records* L1/L2 and *gates* on them (an unresolved L2 code path DEFERS the schema batches that depend on it,
 * and the content those batches provide), then executes the data plane — L3 schema + L4 content — bringing the
 * database into line with the freshly-deployed code. Which L2 mode applies (`merge` vs `locked`) is chosen by
 * edition, matching §7 of the design.
 *
 * Crash-resume is free: L3 is ledgered (already-applied batches skip) and L4 is content-addressed (adopted
 * rows read `in_sync`), so re-running a crashed `running` apply run converges without double-applying.
 *
 * The engine-specific operations — taking the snapshot, running the SQLite batch runner, and restoring
 * (which for SQLite must close/reopen the write connection) — are injected via {@link ApplyContext} so this
 * orchestrator stays dialect-neutral and unit-testable.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import type { UpgradeManifest } from '@weaveintel/upgrade';
import type { SnapshotHandle } from '@weaveintel/upgrade';
import { tryAcquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock-store.js';
import { runPreflight, type PreflightResult } from './upgrade-preflight.js';
import { setMaintenance, clearMaintenance } from './upgrade-maintenance.js';
import {
  beginUpgradeRun, recordUpgradeDetail, finishUpgradeRun, latestUpgradeRun,
} from './upgrade-run-store.js';
import { reconcileAllRealmFamilies, type RealmSeedDefaults } from './realm-seed-reconcile.js';

/** The L2 handling mode, selected by edition (Community merges; Private swaps a locked tree). */
export type EditionL2Mode = 'merge' | 'locked';

/** Dispositions that leave an unresolved review item (⇒ `succeeded_with_pending`). */
const PENDING_DISPOSITIONS = ['diverged', 'conflict', 'collision', 'deferred', 'removed'] as const;

/** The lock holder label for an apply (one at a time, instance-wide). */
const APPLY_LOCK_HOLDER = 'upgrade-apply';

/**
 * Choose the L2 mode for an edition. Community merges upstream code (per-file B/L/R); every other edition is
 * treated as locked (whole-tree swap, no per-file holds). The design foresees a realm-managed policy row; env
 * edition is the source that exists today.
 * @param edition the instance edition string.
 * @returns 'merge' for community, otherwise 'locked'.
 */
export function resolveEditionL2Mode(edition: string): EditionL2Mode {
  return edition === 'community' ? 'merge' : 'locked';
}

/**
 * Compute the deferral set: schema batches whose L2 code dependency is unresolved must be held (they stay
 * pending and a later apply picks them up once the code lands), along with the content families those batches
 * provide (whose schema isn't in place yet). In `locked` mode the tree is swapped wholesale, so there are no
 * per-file conflicts and nothing defers.
 * @param manifest the release manifest (its `layers.schema[].dependsOn` / `.provides`).
 * @param unresolvedCodePaths L2 paths the out-of-band merge left in conflict.
 * @param l2mode the edition's L2 mode.
 * @returns the deferred batch ids and the families they provide (to hold from L4).
 */
export function computeDeferral(
  manifest: UpgradeManifest,
  unresolvedCodePaths: readonly string[],
  l2mode: EditionL2Mode,
): { deferredBatchIds: Set<string>; deferredFamilies: Set<string> } {
  const unresolved = l2mode === 'locked' ? [] : unresolvedCodePaths; // locked = whole-tree swap, no per-file holds
  const deferredBatchIds = new Set<string>();
  const deferredFamilies = new Set<string>();
  for (const b of manifest.layers.schema) {
    if (b.dependsOn.some((p) => unresolved.includes(p))) {
      deferredBatchIds.add(b.batchId);
      // `provides` tokens are `family` or `family:key`; the family is the part before the first ':'.
      for (const prov of b.provides) deferredFamilies.add(prov.split(':')[0]!);
    }
  }
  return { deferredBatchIds, deferredFamilies };
}

/** A shallow copy of the desired defaults with the named families removed (so L4 holds them at baseline). */
function withoutFamilies(defaults: RealmSeedDefaults, families: ReadonlySet<string>): RealmSeedDefaults {
  if (families.size === 0) return defaults;
  const out: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const [fam, rows] of Object.entries(defaults)) {
    if (!families.has(fam) && rows) out[fam] = rows;
  }
  return out;
}

/** The engine-specific operations + config an apply needs; injected so the orchestrator stays dialect-neutral. */
export interface ApplyContext {
  /** The CURRENT SqlClient — re-read each use so a post-rollback reconnect (SQLite) is transparent. */
  readonly client: () => SqlClient;
  readonly dialect: SqlDialect;
  readonly manifest: UpgradeManifest;
  /** The installed application version (recorded as the run's from_version). */
  readonly installedVersion: string;
  /** This instance's edition (selects the L2 mode + gates in preflight). */
  readonly edition: string;
  /** The SQLite DB file path for preflight's disk gate; null for Postgres. */
  readonly dbPath?: string | null;
  /** L2 paths the out-of-band code merge left unresolved (Community only); default none. */
  readonly unresolvedCodePaths?: readonly string[];
  /** The desired content defaults for L4 (e.g. `collectRealmSeedDefaults()`). */
  readonly defaults: RealmSeedDefaults;
  /** Skip preflight gating (operator override). */
  readonly force?: boolean;
  /** Take a pre-upgrade snapshot NOW (engine-specific). */
  readonly snapshot: () => SnapshotHandle;
  /** Run the L3 schema layer: the pending, non-deferred migration batches (strict; throws on failure). */
  readonly runSchema: (deferredBatchIds: ReadonlySet<string>) => Promise<{ applied: string[]; skipped: string[] }>;
  /** Restore from a snapshot after an L3 failure (+ reopen the SQLite connection); afterwards `client()` is fresh. */
  readonly rollback: (handle: SnapshotHandle) => Promise<void>;
  /** Optional installed-version reader for preflight's package gate (tests). */
  readonly readInstalledPackageVersion?: (name: string) => string | null;
  /** Timestamp override for run/detail rows (tests / deterministic replay). */
  readonly at?: string;
  /** Clock injection for the mutex staleness window (tests). */
  readonly now?: () => Date;
}

/** The outcome of an apply. */
export interface ApplyResult {
  readonly status: 'succeeded' | 'succeeded_with_pending' | 'rolled_back' | 'busy' | 'preflight_failed';
  readonly runId?: string;
  /** True when this call continued a previously-crashed `running` apply run. */
  readonly resumed?: boolean;
  readonly schema?: { applied: string[]; deferred: string[] };
  readonly content?: { adopted: number; published: number; review: number };
  /** Count of unresolved review items left behind (⇒ succeeded_with_pending). */
  readonly pending?: number;
  readonly preflight?: PreflightResult;
  readonly error?: string;
}

/**
 * Apply a release: mutex → preflight → maintenance → snapshot → L1/L2 record + deferral → L3 (strict/ledgered)
 * → L4 (registry reconcile, deferred families held) → finalize (succeeded / succeeded_with_pending), or restore
 * the snapshot and finish `rolled_back` if L3 fails.
 *
 * @param ctx the injected engine ops + config (see {@link ApplyContext}).
 * @returns the {@link ApplyResult}. Side effects: the whole upgrade — an `upgrade_runs` row + per-item
 *   `upgrade_details`, migration batches applied to the schema, adopted content rows, the maintenance flag
 *   raised/cleared, and (only on L3 failure) a snapshot restore.
 */
export async function applyUpgrade(ctx: ApplyContext): Promise<ApplyResult> {
  const { dialect, manifest, at } = ctx;
  const version = manifest.version;

  // 1. Preflight gate (unless forced) — BEFORE acquiring the mutex, so preflight's own `mutex` gate reflects
  //    whether ANOTHER operation holds the lock (not this apply's own hold).
  const preflight = await runPreflight(ctx.client(), dialect, {
    manifest, edition: ctx.edition, installedVersion: ctx.installedVersion, dbPath: ctx.dbPath ?? null,
    ...(ctx.readInstalledPackageVersion ? { readInstalledPackageVersion: ctx.readInstalledPackageVersion } : {}),
  });
  if (!ctx.force && !preflight.ok) return { status: 'preflight_failed', preflight };

  // 2. Mutex — one apply at a time. Managed manually (not `withUpgradeLock`) because a rollback reopens the
  //    SQLite connection, so acquire/release must each read the CURRENT client via ctx.client(). A lost race
  //    here (someone acquired between preflight and now) is a normal `busy`.
  const acquired = await tryAcquireUpgradeLock(ctx.client(), dialect, APPLY_LOCK_HOLDER, ctx.now ? { now: ctx.now } : {});
  if (!acquired) return { status: 'busy' };

  try {
    // 3. Resume: continue a crashed `running` apply run for the SAME target instead of opening a new one.
    const existing = await latestUpgradeRun(ctx.client(), dialect, 'apply');
    const resuming = existing?.status === 'running' && existing.to_version === version;
    const runId = resuming
      ? existing!.id
      : await beginUpgradeRun(ctx.client(), dialect, { mode: 'apply', fromVersion: ctx.installedVersion, toVersion: version, at });

    const l2mode = resolveEditionL2Mode(ctx.edition);
    const { deferredBatchIds, deferredFamilies } = computeDeferral(manifest, ctx.unresolvedCodePaths ?? [], l2mode);

    // 4. Maintenance ON — shed user traffic for the mutating window.
    await setMaintenance(ctx.client(), dialect, `applying release ${version}`, at);

    // 5. Record the L1/L2 plan + the deferral holds (only on a fresh run — resume already has them).
    if (!resuming) {
      const staleNames = new Set(
        (((preflight.gates.find((g) => g.name === 'packages')?.data as { stale?: Array<{ name: string }> } | undefined)?.stale) ?? []).map((s) => s.name),
      );
      for (const p of manifest.layers.packages) {
        await recordUpgradeDetail(ctx.client(), dialect, runId, {
          family: 'packages', logicalKey: p.name, layer: 'L1',
          disposition: staleNames.has(p.name) ? 'stale' : 'in_sync', remoteHash: p.version, priority: 'P3',
        });
      }
      if (manifest.layers.code) {
        const conflicted = l2mode === 'merge' && (ctx.unresolvedCodePaths?.length ?? 0) > 0;
        await recordUpgradeDetail(ctx.client(), dialect, runId, {
          family: 'code', logicalKey: manifest.layers.code.repoTag, layer: 'L2',
          disposition: conflicted ? 'conflict' : 'new', remoteHash: manifest.layers.code.fileManifestDigest,
          note: `L2 mode: ${l2mode}`, priority: conflicted ? 'P1' : 'P3',
        });
      }
      for (const bid of deferredBatchIds) {
        await recordUpgradeDetail(ctx.client(), dialect, runId, {
          family: 'schema', logicalKey: bid, layer: 'L3', disposition: 'deferred',
          note: 'held: an L2 code dependency is unresolved', priority: 'P3',
        });
      }
    }

    // 6. Snapshot — taken AFTER the run row exists so a restore keeps it (we then mark it rolled_back).
    const handle = ctx.snapshot();

    // 7. L3 — the pending, non-deferred schema batches, strict (a failure throws → restore).
    let applied: string[];
    try {
      const r = await ctx.runSchema(deferredBatchIds);
      applied = r.applied;
    } catch (err) {
      await ctx.rollback(handle);              // restore the pre-L3 snapshot (+ reopen the SQLite connection)
      await clearMaintenance(ctx.client(), dialect);
      await finishUpgradeRun(ctx.client(), dialect, runId, { status: 'rolled_back', summary: { error: 1 }, at });
      await handle.discard();
      return { status: 'rolled_back', runId, error: (err as Error).message };
    }
    for (const id of applied) {
      await recordUpgradeDetail(ctx.client(), dialect, runId, {
        family: 'schema', logicalKey: id, layer: 'L3', disposition: 'adopted', priority: 'P3',
      });
    }

    // 8. L4 — registry reconcile under THIS run (deferred families held at baseline). Records its own details.
    const filteredDefaults = withoutFamilies(ctx.defaults, deferredFamilies);
    const l4 = await reconcileAllRealmFamilies(ctx.client(), dialect, filteredDefaults, { runId, ...(at ? { at } : {}) });
    // Surface deferred content as `deferred` details (a family a held batch provides, that we didn't adopt).
    for (const c of manifest.layers.content) {
      if (deferredFamilies.has(c.family)) {
        await recordUpgradeDetail(ctx.client(), dialect, runId, {
          family: c.family, logicalKey: c.logicalKey, layer: 'L4', disposition: 'deferred',
          remoteHash: c.remoteHash, note: c.releaseNote, priority: c.priority ?? 'P3',
        });
      }
    }

    // 9. Maintenance OFF.
    await clearMaintenance(ctx.client(), dialect);

    // 10. Finalize — item-granular: any unresolved review item ⇒ succeeded_with_pending (never a hostage-taker).
    const pending = await countPendingReview(ctx.client(), dialect, runId);
    const status = pending > 0 ? 'succeeded_with_pending' : 'succeeded';
    const content = {
      adopted: Number(l4.summary['adopted'] ?? 0),
      published: Number(l4.summary['published'] ?? 0),
      review: l4.perFamily.reduce((n, f) => n + f.review.length, 0),
    };
    await finishUpgradeRun(ctx.client(), dialect, runId, {
      status,
      summary: { schemaApplied: applied.length, schemaDeferred: deferredBatchIds.size, contentAdopted: content.adopted, pending },
      at,
    });
    await handle.discard();
    return { status, runId, resumed: resuming, schema: { applied, deferred: [...deferredBatchIds] }, content, pending };
  } finally {
    // Release via the CURRENT client (fresh after any rollback-reopen).
    await releaseUpgradeLock(ctx.client(), dialect, APPLY_LOCK_HOLDER);
  }
}

/**
 * Count unresolved review items recorded under a run — the ones that make an otherwise-clean apply
 * `succeeded_with_pending` (genuine conflicts, collisions, deferrals, orphaned removals; not operator edits
 * that were simply kept).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the run to count under.
 * @returns the number of unresolved review items.
 */
async function countPendingReview(client: SqlClient, dialect: SqlDialect, runId: string): Promise<number> {
  const inList = PENDING_DISPOSITIONS.map((d) => `'${d}'`).join(', ');
  const { rows } = await client.query(
    `SELECT count(*) AS c FROM upgrade_details WHERE run_id = ${dialect === 'postgres' ? '$1' : '?'} AND resolution IS NULL AND disposition IN (${inList})`,
    [runId],
  );
  return Number((rows[0] as { c?: number | string })?.c ?? 0);
}
