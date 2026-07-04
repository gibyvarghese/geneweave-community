/**
 * GeneWeave — Artifact Retention Job (m77 Phase 1)
 *
 * Runs at startup and then every 6 hours to delete artifacts whose policy
 * retention period has elapsed. Calls `db.expireArtifacts()` which executes
 * a SQL DELETE with a JOIN on `artifact_policies.retention_days`.
 *
 * Returns a cleanup handle — call `stop()` on graceful shutdown.
 */

import type { DatabaseAdapter } from './db-types.js';

// Run every 6 hours. Retention is calendar-day granularity so sub-hour
// precision is not needed; 6 h keeps the deletion lag < 25% of a day.
const INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runRetention(db: DatabaseAdapter): Promise<void> {
  if (!db.expireArtifacts) return;
  const deleted = await db.expireArtifacts();
  if (deleted > 0) {
    process.stdout.write(`[ArtifactRetentionJob] Expired ${deleted} artifact(s)\n`);
  }
}

/**
 * Start the artifact retention job.
 *
 * Runs once immediately on startup, then every 6 hours.
 * Returns a cleanup handle — call `stop()` on graceful shutdown.
 */
export function startArtifactRetentionJob(db: DatabaseAdapter): { stop: () => void } {
  // Run immediately on startup (best-effort — never throws)
  runRetention(db).catch((err) => {
    process.stderr.write(`[ArtifactRetentionJob] Startup pass failed: ${err}\n`);
  });

  const handle = setInterval(() => {
    runRetention(db).catch((err) => {
      process.stderr.write(`[ArtifactRetentionJob] Periodic pass failed: ${err}\n`);
    });
  }, INTERVAL_MS);

  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as NodeJS.Timeout).unref();
  }

  return { stop: () => clearInterval(handle) };
}
