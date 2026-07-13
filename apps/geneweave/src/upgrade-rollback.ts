// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — MANUAL rollback (`rollback --run <id>`).
 *
 * Apply already rolls back automatically when L3 fails or post-apply verify fails. This is the operator's
 * escape hatch for a run that *succeeded* but later proves bad: it restores that run's RETAINED pre-upgrade
 * snapshot (recorded in `upgrade_runs.snapshot_ref`), putting the database back exactly where it was, marks
 * the run `rolled_back`, and files a P1 audit item. Retention is bounded to the newest successful apply, so
 * only that run is reversible this way; an older run whose snapshot was discarded reports `no_snapshot`.
 *
 * Like apply, it runs under the upgrade mutex (no concurrent apply/rollback) and takes its engine-specific
 * restore as an injected callback so this module stays dialect-neutral.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { tryAcquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock-store.js';
import { clearMaintenance } from './upgrade-maintenance.js';
import {
  getUpgradeRun, setRunSnapshotRef, recordUpgradeDetail, finishUpgradeRun,
} from './upgrade-run-store.js';

const ROLLBACK_LOCK_HOLDER = 'upgrade-rollback';

/** The outcome of a manual rollback. */
export interface RollbackResult {
  readonly status: 'rolled_back' | 'not_found' | 'no_snapshot' | 'busy';
  readonly runId: string;
  readonly message?: string;
}

/** Engine-specific ops + config for a manual rollback (injected so the core stays dialect-neutral). */
export interface RollbackContext {
  /** The CURRENT SqlClient — re-read each use so a post-restore reconnect (SQLite) is transparent. */
  readonly client: () => SqlClient;
  readonly dialect: SqlDialect;
  /** Restore the database from a stored snapshot ref (+ reopen the SQLite connection); after this `client()` is fresh. */
  readonly restoreFromRef: (ref: string) => Promise<void>;
  /** Delete the snapshot artifact once consumed; defaults to a no-op. */
  readonly discardSnapshot?: (ref: string) => Promise<void>;
  /** Who initiated the rollback (a user id), for the audit note. */
  readonly by?: string;
  /** Clock injection for the mutex staleness window (tests). */
  readonly now?: () => Date;
  /** Timestamp override for the audit/finish rows (tests). */
  readonly at?: string;
}

/**
 * Roll back a specific run to its retained pre-upgrade snapshot.
 * @param ctx the injected client/restore/config.
 * @param runId the run to reverse.
 * @returns a {@link RollbackResult}: `rolled_back` on success; `not_found` (no such run), `no_snapshot` (its
 *   snapshot was discarded/superseded), or `busy` (another upgrade op holds the mutex). Side effects on
 *   success: the database is restored to the snapshot, the run is marked `rolled_back`, a P1 audit detail is
 *   filed, and the snapshot artifact is discarded.
 */
export async function rollbackUpgradeRun(ctx: RollbackContext, runId: string): Promise<RollbackResult> {
  const { dialect } = ctx;
  const run = await getUpgradeRun(ctx.client(), dialect, runId);
  if (!run) return { status: 'not_found', runId, message: `no upgrade run ${runId}` };
  if (!run.snapshot_ref) {
    return { status: 'no_snapshot', runId, message: 'no retained snapshot for this run (already rolled back, or superseded by a newer upgrade)' };
  }

  const acquired = await tryAcquireUpgradeLock(ctx.client(), dialect, ROLLBACK_LOCK_HOLDER, ctx.now ? { now: ctx.now } : {});
  if (!acquired) return { status: 'busy', runId };

  const ref = run.snapshot_ref;
  try {
    // Restore the database to the snapshot (reverts schema + content + the ledger). The restored image shows
    // the run as it was mid-apply; the writes below re-stamp it as rolled_back on the restored database.
    await ctx.restoreFromRef(ref);
    await clearMaintenance(ctx.client(), dialect); // in case the restored image had maintenance raised
    await setRunSnapshotRef(ctx.client(), dialect, runId, null);
    await recordUpgradeDetail(ctx.client(), dialect, runId, {
      family: 'rollback', logicalKey: runId, layer: 'verify', disposition: 'conflict', // conflict ⇒ P1
      note: `manually rolled back${ctx.by ? ` by ${ctx.by}` : ''}`, priority: 'P1',
    });
    await finishUpgradeRun(ctx.client(), dialect, runId, { status: 'rolled_back', summary: { manualRollback: 1 }, at: ctx.at });
    if (ctx.discardSnapshot) await ctx.discardSnapshot(ref);
    return { status: 'rolled_back', runId };
  } finally {
    await releaseUpgradeLock(ctx.client(), dialect, ROLLBACK_LOCK_HOLDER);
  }
}
