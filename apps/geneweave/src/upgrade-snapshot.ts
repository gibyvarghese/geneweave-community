// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — pre-apply snapshots for atomic rollback.
 *
 * An upgrade mutates the database (schema migrations, seed reconcile). If a later step fails —
 * verification, a bad migration, a crash — the operator must be able to get back exactly to where they
 * were. Before it touches anything, the orchestrator takes a snapshot; on failure it restores it. This
 * module provides that snapshot for both engines behind one small interface:
 *
 *   • SQLite  — WAL-checkpoint the database into its main file, then copy that file. A SQLite database is a
 *               single file, so an atomic file copy after a TRUNCATE checkpoint is a complete, consistent
 *               snapshot — and near-free. Restore copies the file back (the caller reopens the connection).
 *   • Postgres — `pg_dump` to a file; restore replays it with `psql`. Requires the client binaries on PATH
 *               (overridable). This is a logical dump, not a physical one — appropriate for the single-node
 *               upgrade scope; a physical base-backup is a later, larger-scale concern.
 *
 * Deliberately minimal and dependency-free (node:fs + node:child_process). The engine-generic *shape* — a
 * handle you can `restore()` or `discard()` — is the `SnapshotHandle` interface, which is what moves into
 * `@weaveintel/upgrade`; the two concrete makers stay app-side because they are inherently engine-specific.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * A taken snapshot. `ref` identifies it (a file path); `restore()` puts the database back to the snapshot;
 * `discard()` deletes the snapshot artifact. Both are idempotent and safe to call once the upgrade settles.
 */
export interface SnapshotHandle {
  /** Opaque reference to the snapshot artifact (the dump/copy path). */
  readonly ref: string;
  /**
   * Restore the database to this snapshot. For SQLite the caller MUST have no open write connection to the
   * target file (close before restore, reopen after). For Postgres this drops+recreates objects from the
   * dump. Returns when the restore completes.
   */
  restore(): Promise<void>;
  /** Delete the snapshot artifact. A no-op if already gone. */
  discard(): Promise<void>;
}

/** Where snapshots are written by default (overridable per call). */
function defaultSnapshotDir(): string {
  const dir = join(tmpdir(), 'geneweave-upgrade-snapshots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Snapshot a SQLite database by folding its WAL into the main file and copying it.
 * @param db an OPEN better-sqlite3 handle to the database (used only to run the checkpoint pragma).
 * @param dbPath the on-disk path of that database's main file (what gets copied).
 * @param opts.dir snapshot destination directory (defaults to a temp dir).
 * @param opts.label a short label folded into the snapshot filename for readability.
 * @returns a handle whose `restore()` copies the snapshot back over `dbPath` (caller reopens the DB) and
 *          whose `discard()` deletes the copy. Side effect: a `wal_checkpoint(TRUNCATE)` on `db` + a file copy.
 */
export function snapshotSqliteFile(
  db: BetterSqlite3.Database,
  dbPath: string,
  opts: { dir?: string; label?: string } = {},
): SnapshotHandle {
  // Fold the WAL back into the main database file so the single-file copy is a complete, consistent image.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode — the main file is already whole */ }
  const dir = opts.dir ?? defaultSnapshotDir();
  const ref = join(dir, `${basename(dbPath)}.${opts.label ?? 'pre-upgrade'}.snapshot`);
  copyFileSync(dbPath, ref);
  return {
    ref,
    async restore(): Promise<void> {
      // Copy the snapshot back over the live file. The caller must ensure no open write handle exists.
      copyFileSync(ref, dbPath);
    },
    async discard(): Promise<void> {
      try { rmSync(ref, { force: true }); } catch { /* already gone */ }
    },
  };
}

/**
 * Snapshot a Postgres database with `pg_dump`, restorable with `psql`.
 * @param connectionString a libpq connection string for the target database.
 * @param opts.dir snapshot destination directory (defaults to a temp dir).
 * @param opts.label a short label folded into the dump filename.
 * @param opts.pgDump path to the `pg_dump` binary (defaults to 'pg_dump' on PATH).
 * @param opts.psql path to the `psql` binary used for restore (defaults to 'psql' on PATH).
 * @returns a handle whose `restore()` replays the dump and whose `discard()` deletes it. Side effect:
 *          spawns `pg_dump` now (writes the dump file). Throws if `pg_dump` fails or is not found.
 */
export function snapshotPgDump(
  connectionString: string,
  opts: { dir?: string; label?: string; pgDump?: string; psql?: string } = {},
): SnapshotHandle {
  const dir = opts.dir ?? defaultSnapshotDir();
  const ref = join(dir, `pg.${opts.label ?? 'pre-upgrade'}.${process.pid}.sql`);
  const pgDump = opts.pgDump ?? 'pg_dump';
  const psql = opts.psql ?? 'psql';
  // Plain-SQL dump with drop statements so the restore is self-cleaning (`--clean --if-exists`). The
  // connection string is passed as a single argv element (never shell-interpolated) → injection-safe.
  execFileSync(pgDump, ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--file', ref, connectionString], { stdio: 'pipe' });
  return {
    ref,
    async restore(): Promise<void> {
      execFileSync(psql, ['--quiet', '--file', ref, connectionString], { stdio: 'pipe' });
    },
    async discard(): Promise<void> {
      try { rmSync(ref, { force: true }); } catch { /* already gone */ }
    },
  };
}
