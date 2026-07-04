/**
 * GeneWeave — weaveNotes Activity Retention Job (Phase 0-B).
 *
 * The note activity/audit log grows with every note edit and AI action. Left unbounded it would
 * dominate storage and slow the admin audit viewer. This job enforces the Builder-configured
 * `weaveNotes Settings → Activity kept for (days)` (activity_retention_days): on boot and every 6
 * hours it deletes activity rows older than that horizon.
 *
 * Mirrors artifact-retention-job.ts. Best-effort (never throws); returns a handle — call stop() on
 * graceful shutdown. Retention is calendar-day granularity, so a 6-hour sweep keeps lag < 25% of a day.
 */
import { createTenantGovernanceService } from './tenant-governance-sql.js';
import type { DatabaseAdapter } from './db-types.js';

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function runRetention(db: DatabaseAdapter): Promise<void> {
  if (!db.pruneNoteActivity || !db.getWeaveNotesSettings) return;

  // 1) Global default retention (weaveNotes Settings).
  const cfg = await db.getWeaveNotesSettings();
  const days = cfg?.activity_retention_days ?? 0;
  if (days && days > 0) {
    const cutoffIso = new Date(Date.now() - days * DAY_MS).toISOString();
    const deleted = await db.pruneNoteActivity(cutoffIso);
    if (deleted > 0) process.stdout.write(`[NoteActivityRetentionJob] Pruned ${deleted} activity row(s) older than ${days}d\n`);
  }

  // 2) Phase 2 — per-tenant governance retention (each tenant's own window; legal hold suspends it).
  try {
    const gov = createTenantGovernanceService(db as unknown as Parameters<typeof createTenantGovernanceService>[0]);
    const results = (await gov.runActivityRetentionSweep()).filter((r) => r.pruned > 0);
    for (const r of results) process.stdout.write(`[NoteActivityRetentionJob] Tenant ${r.tenantId}: pruned ${r.pruned} activity row(s)\n`);
  } catch { /* best-effort */ }
}

export function startNoteActivityRetentionJob(db: DatabaseAdapter): { stop: () => void } {
  runRetention(db).catch((err) => process.stderr.write(`[NoteActivityRetentionJob] Startup pass failed: ${err}\n`));
  const handle = setInterval(() => {
    runRetention(db).catch((err) => process.stderr.write(`[NoteActivityRetentionJob] Periodic pass failed: ${err}\n`));
  }, INTERVAL_MS);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as NodeJS.Timeout).unref();
  return { stop: () => clearInterval(handle) };
}
