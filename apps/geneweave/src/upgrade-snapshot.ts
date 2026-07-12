// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — pre-apply snapshots for atomic rollback.
 *
 * The snapshot makers are engine-generic (a WAL-checkpointed SQLite file copy; a Postgres `pg_dump`), so
 * they live in `@weaveintel/upgrade`. This module re-exports them under the app's existing path so callers
 * and tests are unchanged.
 */
export { snapshotSqliteFile, snapshotPgDump, type SnapshotHandle } from '@weaveintel/upgrade';
