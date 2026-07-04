// SPDX-License-Identifier: MIT
/**
 * geneWeave — weaveNotes Background Memory Job (Phase 5, the "second brain").
 *
 * On a timer, distils DURABLE memories from notes that have changed since we last processed them
 * (facts, preferences, decisions, people, commitments) into the user's personal memory — so the
 * assistant proactively understands the user across notes and chats. Budget-bounded per tick,
 * best-effort (never throws), config-gated (respects background_memory_enabled). Returns a handle —
 * call stop() on graceful shutdown. A manual "remember this note now" goes through the API.
 */
import { createNoteMemoryService } from './note-memory-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

const INTERVAL_MS = 90 * 1000; // gentle cadence — durable memory is not time-critical

export function startNoteMemoryJob(db: DatabaseAdapter, generate: NoteAiGenerate): { stop: () => void } {
  const settings = createNoteSettingsService(db);
  const svc = createNoteMemoryService(db, {
    generate,
    config: async () => {
      const c = await settings.getConfig();
      return { enabled: c.backgroundMemoryEnabled, importanceThreshold: c.memoryImportanceThreshold, maxPerNote: c.memoryMaxPerNote, recallCount: c.memoryRecallCount, decayHalfLifeDays: c.memoryDecayHalfLifeDays };
    },
  });
  const tick = async (): Promise<void> => {
    try {
      const { processed, added } = await svc.runDue(15);
      if (added > 0) process.stdout.write(`[NoteMemoryJob] remembered ${added} thing(s) from ${processed} note(s)\n`);
    } catch (err) { process.stderr.write(`[NoteMemoryJob] tick failed: ${err}\n`); }
  };
  const handle = setInterval(() => { void tick(); }, INTERVAL_MS);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as NodeJS.Timeout).unref();
  return { stop: () => clearInterval(handle) };
}
