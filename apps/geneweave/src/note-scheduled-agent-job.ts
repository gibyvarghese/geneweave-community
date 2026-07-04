// SPDX-License-Identifier: MIT
/**
 * geneWeave — weaveNotes Scheduled Agent Job (Phase 3).
 *
 * Fires schedule-triggered workspace agents whose next run is due. Polls once a minute (the cron
 * granularity); each due agent runs inside its own token/step budget and is fully audited. Best-effort
 * (never throws; a failed agent run is recorded by the runner). Returns a handle — call stop() on
 * graceful shutdown. Manual "run now" goes through the API, not this loop.
 */
import { createNoteScheduledAgentService } from './note-scheduled-agent-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

const INTERVAL_MS = 60 * 1000; // cron resolution is one minute

export function startNoteScheduledAgentJob(db: DatabaseAdapter, generate: NoteAiGenerate): { stop: () => void } {
  const svc = createNoteScheduledAgentService(db, generate);
  const tick = async (): Promise<void> => {
    try {
      const { fired } = await svc.runDue(25);
      if (fired > 0) process.stdout.write(`[NoteScheduledAgentJob] fired ${fired} due scheduled agent(s)\n`);
    } catch (err) { process.stderr.write(`[NoteScheduledAgentJob] tick failed: ${err}\n`); }
  };
  const handle = setInterval(() => { void tick(); }, INTERVAL_MS);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as NodeJS.Timeout).unref();
  return { stop: () => clearInterval(handle) };
}
