/**
 * Phase 4 — Process-singleton RunCancellationBus for geneWeave.
 *
 * Shared between:
 *   - `POST /api/live-agents/runs/:runId/stop` (fires cancel on stop)
 *   - Any live-agent handler that accepts an AbortSignal for its run
 *
 * Import `getCancellationBus()` to retrieve the singleton.
 */
import { RunCancellationBus } from '@weaveintel/live-agents-runtime';

let bus: RunCancellationBus | null = null;

export function getCancellationBus(): RunCancellationBus {
  if (!bus) bus = new RunCancellationBus();
  return bus;
}
