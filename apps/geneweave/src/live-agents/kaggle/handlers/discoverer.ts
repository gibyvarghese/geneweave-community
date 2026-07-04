/** Kaggle Discoverer — agentic seed + deterministic top-N forwarder. */
import type { TaskHandler } from '@weaveintel/live-agents';
import type { KaggleCompetition } from '../../../kaggle/index.js';
import { competitionSlugFrom, emitToNextAgent, resolveCreds, type SharedHandlerContext } from './_shared.js';
import { probeCompetitionFiles, renderIntelHeader, type CompetitionIntel } from '../competition-probe.js';

/**
 * Run the file-level probe against every competition we are about to forward.
 * Best-effort: any failure produces an `unknown`-shape intel record without
 * blocking the handoff.
 */
async function probeAll(
  ctx: SharedHandlerContext,
  comps: KaggleCompetition[],
): Promise<Map<string, CompetitionIntel>> {
  const { adapter, log, opts } = ctx;
  const creds = resolveCreds(opts);
  const out = new Map<string, CompetitionIntel>();
  for (const c of comps) {
    const slug = competitionSlugFrom(c.id);
    if (!slug) continue;
    try {
      const intel = await probeCompetitionFiles(adapter, creds, slug, { log });
      out.set(slug, intel);
      log(
        `Discoverer probe ${slug}: shape=${intel.shape} format=${intel.submissionFormat} files=${intel.files.length} libs=${intel.libraries.length} envHints=[${intel.envHints.join(',')}]`,
      );
    } catch (err) {
      log(
        `Discoverer probe ${slug} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Resolve the competition slug to pin this discoverer tick to. Resolution
 * order (most-specific first):
 *   1. The `kgl_competition_run` row that owns this mesh — every run is
 *      created with a `competition_ref` (URL or slug), and the discoverer
 *      MUST stay on-mission for that run. Without this, every strategist
 *      across every concurrent run receives the same top-N seed and
 *      converges on whichever competition is first in the list.
 *   2. `KAGGLE_COMPETITION_SLUG` env var — process-wide override for
 *      single-run dev loops.
 *   3. `null` — no pin; caller falls through to top-N discovery.
 */
async function resolveRunPinnedSlug(
  ctx: SharedHandlerContext,
  meshId: string,
): Promise<string | null> {
  const db = ctx.opts.db;
  if (db) {
    try {
      const runs = await db.listKglCompetitionRuns({ status: 'running', limit: 100 });
      const run = runs.find((r) => r.mesh_id === meshId);
      if (run?.competition_ref) {
        const slug = competitionSlugFrom(run.competition_ref);
        if (slug) return slug;
      }
    } catch (err) {
      ctx.log(
        `!! discoverer: failed to look up kgl_competition_run for mesh=${meshId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const envPin = process.env['KAGGLE_COMPETITION_SLUG']?.trim();
  return envPin ? envPin : null;
}

/** Agentic mode: pick top-N (or pinned) competitions and seed the strategist. */
export function createDiscovererAgentic(ctx: SharedHandlerContext): TaskHandler {
  return async (_action, context) => {
    const { adapter, log, getOpDefaults, opts } = ctx;
    log('Discoverer (agentic mode): seeding strategist with top competitions.');
    const creds = resolveCreds(opts);
    const opDefaults = await getOpDefaults();
    const pinnedSlug = await resolveRunPinnedSlug(ctx, context.agent.meshId);
    let top: KaggleCompetition[];
    if (pinnedSlug) {
      log(`Discoverer: pinned to competition slug=${pinnedSlug} (mesh=${context.agent.meshId})`);
      const comp = await adapter.getCompetition(creds, pinnedSlug);
      top = [comp];
    } else {
      const comps = await adapter.listCompetitions(creds, { page: 1 });
      top = comps.slice(0, opDefaults.topNAgentic);
    }
    const summary = top
      .map((c) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
      .join('\n');
    // When pinned (the common case once a kgl_competition_run owns this
    // mesh) prepend an unambiguous `competitionId: <slug>` marker so the
    // strategist's playbook resolver picks the right playbook for THIS run
    // instead of guessing from whatever slug appears first in the summary.
    const headerLines: string[] = [];
    if (pinnedSlug && top.length === 1 && top[0]) {
      headerLines.push(`competitionId: ${competitionSlugFrom(top[0].id)}`);
    }
    // Run the per-competition probe so the strategist starts already
    // knowing the file inventory, candidate libraries, and any env hints.
    // Without this the strategist guesses (e.g. `make("crawl", ...)` for
    // maze-crawler) and burns tool budget on rediscovery every tick.
    const intelMap = await probeAll(ctx, top);
    const intelHeaders = top
      .map((c) => {
        const slug = competitionSlugFrom(c.id);
        const intel = slug ? intelMap.get(slug) : undefined;
        return slug && intel ? renderIntelHeader(slug, intel) : '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
    const body = [
      ...headerLines,
      'Active competitions you may choose from (pick the most tractable one):',
      summary,
      '',
      intelHeaders,
      'Proceed with the workflow described in your system prompt. The DISCOVERED COMPETITION INTEL above was pre-fetched for you — do NOT re-call kaggle_list_competition_files / kaggle_get_competition_file for files already shown above.',
    ].join('\n');
    await emitToNextAgent(
      context,
      'strategist',
      `Seed: ${top.length} candidate competitions`,
      body,
      'kaggle.discovery.seed',
    );
    return {
      completed: true,
      summaryProse: `Seeded strategist with ${top.length} candidate competitions.`,
    };
  };
}

/** Deterministic mode: forward top-N as a JSON envelope to the strategist. */
export function createDiscovererDeterministic(ctx: SharedHandlerContext): TaskHandler {
  return async (_action, context) => {
    const { adapter, log, getOpDefaults, opts } = ctx;
    const creds = resolveCreds(opts);
    log('Discoverer fetching competitions...');
    const opDefaults = await getOpDefaults();
    // Same per-run pin logic as the agentic mode — keeps every concurrent
    // competition run on its own competition_ref instead of converging on
    // whichever slug appears first in a shared top-N list.
    const pinnedSlug = await resolveRunPinnedSlug(ctx, context.agent.meshId);
    let top: KaggleCompetition[];
    let totalSeen: number;
    if (pinnedSlug) {
      log(`Discoverer: pinned to competition slug=${pinnedSlug} (mesh=${context.agent.meshId})`);
      const comp = await adapter.getCompetition(creds, pinnedSlug);
      top = [comp];
      totalSeen = 1;
    } else {
      const comps = await adapter.listCompetitions(creds, { page: 1 });
      top = comps.slice(0, opDefaults.topNDeterministic);
      totalSeen = comps.length;
    }
    log(`Discoverer found ${totalSeen} competitions; forwarding top ${top.length} to strategist`);
    const summary = top
      .map((c) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
      .join('\n');
    // Probe each competition so the strategist receives a structured
    // intel block alongside the raw competition list.
    const intelMap = await probeAll(ctx, top);
    const competitionsWithIntel = top.map((c) => {
      const slug = competitionSlugFrom(c.id);
      const intel = slug ? intelMap.get(slug) : undefined;
      return { competition: c, intel: intel ?? null };
    });
    const body = JSON.stringify({ competitions: competitionsWithIntel }, null, 2);
    await emitToNextAgent(
      context,
      'strategist',
      `Discovered ${top.length} candidate competitions`,
      body,
      'kaggle.discovery.candidates',
    );
    return {
      completed: true,
      summaryProse: `Discovered ${totalSeen} competitions; forwarded ${top.length} to strategist:\n${summary}`,
    };
  };
}
