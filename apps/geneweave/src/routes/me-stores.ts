/**
 * routes/me-stores.ts — Shared in-memory stores for the /api/me surface.
 *
 * These are module-level singletons that persist for the process lifetime.
 * They live here (rather than inside a single route module) so that multiple
 * /api/me route modules can share one instance — e.g. routes/me.ts owns task
 * and reminder CRUD, while routes/me-conversations.ts reads the same task repo
 * to derive `hasPendingAction` for a conversation.
 *
 * Production deployments should replace these with durable backends via
 * @weaveintel/persistence (durable human-task repository + trigger store).
 */

import { JsonFileHumanTaskRepository, InMemoryHumanTaskRepository } from '@weaveintel/human-tasks';
import { InMemoryTriggerStore } from '@weaveintel/triggers';
import { join } from 'node:path';

/** Shared action-item / human-task repository for the /api/me surface.
 *  Uses in-memory storage in test environments to prevent disk I/O races
 *  between parallel workers and stale task accumulation across runs. */
export const meTaskRepo = process.env['VITEST']
  ? new InMemoryHumanTaskRepository()
  : new JsonFileHumanTaskRepository(join(process.cwd(), 'geneweave-tasks.json'));

/** Shared reminder/trigger store for the /api/me surface. */
export const meTriggerStore = new InMemoryTriggerStore();

/**
 * Non-terminal task statuses. A conversation has a pending action when it has
 * at least one task whose provenance.sourceRunId points at the conversation and
 * whose status is still open.
 */
export const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'assigned',
  'in-review',
  'escalated',
]);
