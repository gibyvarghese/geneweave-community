// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the single-instance advisory MUTEX over the `upgrade_lock` table (m170).
 *
 * geneWeave has no cross-process lock primitive of its own, so preflight/preview/apply serialise through one
 * fixed row (`id = 'singleton'`). Acquisition is a compare-and-set: an `UPDATE … WHERE holder-is-free-or-stale`
 * followed by a confirming `SELECT`. Both engines serialise the guarded UPDATE on that one row — under SQLite
 * writes are serialised; under Postgres the second writer blocks on the row lock, then re-evaluates its WHERE
 * against the winner's committed row and matches nothing — so exactly one caller ends up as `holder`. A
 * STALE lock (its `acquired_at` older than the caller's staleness window) is reclaimable, so a crashed holder
 * never wedges the instance forever.
 *
 * Written once against the framework's `SqlClient` seam (shared `ph`/`nowExpr`) so it serves SQLite and
 * Postgres with no per-engine copy.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';

/** The one lock row's fixed primary key. */
const LOCK_ID = 'singleton';
/** Default staleness window: a lock whose holder went away is reclaimable after this many ms (10 minutes). */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

/** The current lock state (for reporting / the preflight mutex gate). */
export interface UpgradeLockState {
  /** Who holds the lock, or null when it's free. */
  readonly holder: string | null;
  /** When it was acquired (text 'YYYY-MM-DD HH:MM:SS'), or null when free. */
  readonly acquiredAt: string | null;
}

/** Format a Date as the app's canonical `YYYY-MM-DD HH:MM:SS` UTC text (lexicographically comparable). */
function toDbTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Read the current lock holder.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the holder + acquired_at, or `{ holder: null, acquiredAt: null }` when free (or the row is absent).
 */
export async function upgradeLockState(client: SqlClient, dialect: SqlDialect): Promise<UpgradeLockState> {
  void dialect;
  const { rows } = await client.query(`SELECT holder, acquired_at FROM upgrade_lock WHERE id = '${LOCK_ID}'`);
  const r = rows[0] as { holder?: string | null; acquired_at?: string | null } | undefined;
  return { holder: (r?.holder ?? null) || null, acquiredAt: (r?.acquired_at ?? null) || null };
}

/**
 * Try to acquire the lock for `holder`. Idempotent for the SAME holder (re-acquiring your own lock succeeds
 * and refreshes `acquired_at`). Reclaims a STALE lock whose `acquired_at` is older than `staleMs`.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param holder a label identifying the acquirer (e.g. a run id); must be non-empty.
 * @param opts.staleMs override the staleness window (ms) after which a held lock is reclaimable.
 * @param opts.now clock injection (tests) — the "current time" used for acquired_at + the stale cutoff.
 * @returns true iff this call now holds the lock. Side effect: at most one UPDATE of the singleton row.
 */
export async function tryAcquireUpgradeLock(
  client: SqlClient,
  dialect: SqlDialect,
  holder: string,
  opts: { staleMs?: number; now?: () => Date } = {},
): Promise<boolean> {
  if (!holder) throw new Error('upgrade lock holder must be non-empty');
  const now = opts.now ? opts.now() : new Date();
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const nowText = toDbTime(now);
  const staleCutoff = toDbTime(new Date(now.getTime() - staleMs));

  // Compare-and-set: take the lock only if it's FREE, already OURS, or STALE. The guarded UPDATE is atomic on
  // the one row; the confirming SELECT below tells us whether we're the winner.
  await client.query(
    `UPDATE upgrade_lock
       SET holder = ${ph(dialect, 1)}, acquired_at = ${ph(dialect, 2)}
     WHERE id = '${LOCK_ID}'
       AND (holder IS NULL OR holder = ${ph(dialect, 3)} OR acquired_at <= ${ph(dialect, 4)})`,
    [holder, nowText, holder, staleCutoff],
  );
  const state = await upgradeLockState(client, dialect);
  return state.holder === holder;
}

/**
 * Release the lock — only if `holder` actually holds it (so a late release from a superseded holder can't free
 * someone else's lock).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param holder the label that acquired it.
 * @returns nothing. Side effect: frees the row iff `holder` held it.
 */
export async function releaseUpgradeLock(client: SqlClient, dialect: SqlDialect, holder: string): Promise<void> {
  await client.query(
    `UPDATE upgrade_lock SET holder = NULL, acquired_at = NULL WHERE id = '${LOCK_ID}' AND holder = ${ph(dialect, 1)}`,
    [holder],
  );
}

/**
 * Run `fn` while holding the lock, releasing it in a `finally` even if `fn` throws. If the lock can't be
 * acquired (someone else holds it), `fn` is NOT run and `onBusy` is returned instead.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param holder the acquirer label.
 * @param fn the critical section.
 * @param onBusy the value to return when the lock is already held by someone else.
 * @param opts staleness / clock injection forwarded to {@link tryAcquireUpgradeLock}.
 * @returns `fn`'s result, or `onBusy` when the lock was unavailable.
 */
export async function withUpgradeLock<T>(
  client: SqlClient,
  dialect: SqlDialect,
  holder: string,
  fn: () => Promise<T>,
  onBusy: T,
  opts: { staleMs?: number; now?: () => Date } = {},
): Promise<T> {
  const got = await tryAcquireUpgradeLock(client, dialect, holder, opts);
  if (!got) return onBusy;
  try {
    return await fn();
  } finally {
    await releaseUpgradeLock(client, dialect, holder);
  }
}
