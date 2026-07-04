/** Kaggle Leaderboard Observer — agentic + deterministic.
 *
 * Both modes share the same persistence path via observeLeaderboardOnce when
 * a DB is wired. Without DB, both fall back to a no-op log. */
import type { TaskHandler } from '@weaveintel/live-agents';
import { observeLeaderboardOnce } from '../../../lib/kaggle-validator-runner.js';
import { loadInboundTask, parseInboundJson, resolveCreds, type SharedHandlerContext } from './_shared.js';

/** Agentic mode: short-circuits to no-op when no db wired. */
export function createObserverAgentic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  return async (_a, context) => {
    if (!opts.db) return { completed: true, summaryProse: 'observer: no-op (no db wired)' };
    const inbound = await loadInboundTask(context);
    const parsed = parseInboundJson(inbound?.body);
    const competitionRef =
      (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
    if (!competitionRef) return { completed: true, summaryProse: 'observer: no competitionRef in inbound — skipping' };
    const submissionRef = (parsed['submissionRef'] as string | null | undefined) ?? null;
    const cvScore = typeof parsed['cvScore'] === 'number' ? (parsed['cvScore'] as number) : null;
    const runId = (parsed['runId'] as string | undefined) ?? null;
    try {
      const creds = resolveCreds(opts);
      const result = await observeLeaderboardOnce({
        db: opts.db,
        adapter,
        credentials: creds,
        runId,
        competitionRef,
        submissionRef,
        cvScore,
      });
      log(`observer: observed=${result.observed} public=${result.publicScore} delta=${result.cvLbDelta}`);
      return {
        completed: true,
        summaryProse: result.observed
          ? `Observer: public_score=${result.publicScore} status=${result.rawStatus} delta=${result.cvLbDelta}`
          : 'Observer: no submissions yet.',
      };
    } catch (err) {
      log(`observer: persistence failed: ${err instanceof Error ? err.message : String(err)}`);
      return { completed: true, summaryProse: 'observer: persistence error (non-fatal)' };
    }
  };
}

/** Deterministic mode: identical persistence path; falls back to log-only no-op tick. */
export function createObserverDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  return async (_a, context) => {
    if (opts.db) {
      const inbound = await loadInboundTask(context);
      const parsed = parseInboundJson(inbound?.body);
      const competitionRef =
        (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
      if (competitionRef) {
        try {
          const creds = resolveCreds(opts);
          const result = await observeLeaderboardOnce({
            db: opts.db,
            adapter,
            credentials: creds,
            runId: (parsed['runId'] as string | undefined) ?? null,
            competitionRef,
            submissionRef: (parsed['submissionRef'] as string | null | undefined) ?? null,
            cvScore: typeof parsed['cvScore'] === 'number' ? (parsed['cvScore'] as number) : null,
          });
          log(`observer(persist): observed=${result.observed} public=${result.publicScore} delta=${result.cvLbDelta}`);
          return {
            completed: true,
            summaryProse: result.observed
              ? `Observer: public_score=${result.publicScore} status=${result.rawStatus} delta=${result.cvLbDelta}`
              : 'Observer: no submissions yet.',
          };
        } catch (err) {
          log(`observer(persist): failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    log('Observer tick: nothing to poll yet (no submitted entries).');
    return {
      completed: true,
      summaryProse: 'Observer tick complete; no leaderboard activity to report.',
    };
  };
}
