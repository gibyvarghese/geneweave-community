/** Kaggle Submitter — records the final payload as intent only.
 *
 * Real Kaggle submission is intentionally NOT exposed as an automated tool;
 * it requires a human dual-control Promotion in the live-agents framework. */
import type { TaskHandler } from '@weaveintel/live-agents';
import { loadInboundTask, type SharedHandlerContext } from './_shared.js';

export function createSubmitter(ctx: SharedHandlerContext): TaskHandler {
  const { log } = ctx;
  return async (_a, context) => {
    const inbound = await loadInboundTask(context);
    log(
      `Submitter received payload (${inbound?.body.length ?? 0} bytes). ` +
        `Real submission requires dual-control approval; recording intent only.`,
    );
    return {
      completed: true,
      summaryProse:
        'Submitter recorded submission intent; awaiting human dual-control approval before kaggle.competitions.submit is invoked.',
    };
  };
}
