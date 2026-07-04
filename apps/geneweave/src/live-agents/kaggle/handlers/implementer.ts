/** Kaggle Implementer (Kernel Author) — deterministic mode only.
 *
 * Resolves the playbook by competition slug, asks it for the rendered
 * solver template (preset variables already substituted), pushes it as a
 * Kaggle kernel, polls until terminal, forwards the result to the validator.
 * Agentic mode does not use this handler — the strategist's tool loop pushes
 * kernels directly via createKaggleTools. */

import type { TaskHandler } from '@weaveintel/live-agents';
import {
  competitionSlugFrom,
  emitToNextAgent,
  loadInboundTask,
  normalizeKernelRef,
  pollKernelUntilTerminal,
  resolveCreds,
  tryResolvePlaybook,
  DEFAULT_MAX_ITERATIONS,
  type SharedHandlerContext,
} from './_shared.js';

export function createImplementerDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log, getOpDefaults } = ctx;
  return async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Implementer had no inbound payload; skipped.' };

    let approach: Record<string, unknown> = {};
    try {
      approach = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const competitionSlug = competitionSlugFrom((approach['competitionId'] as string) ?? '');
    const iteration = Number(approach['iteration'] ?? 1);
    const strategyLabel = (approach['strategyLabel'] as string) ?? 'baseline';
    const history = (approach['history'] as Array<{ iteration: number; label: string; status: string }>) ?? [];

    const playbook = await tryResolvePlaybook(
      opts.playbookResolver,
      competitionSlug,
      Math.max(0, iteration - 1),
      {},
      log,
    );

    if (!playbook) {
      const reason = `No playbook resolver configured or no playbook matched competition slug "${competitionSlug}". Skipping kernel push. Configure a playbook resolver and seed a kaggle_playbook skill that matches this slug.`;
      log(reason);
      const payload = {
        competitionId: competitionSlug,
        iteration,
        strategyLabel,
        kernelStatus: 'skipped',
        failureMessage: reason,
        history: [...history, { iteration, label: strategyLabel, status: 'skipped' }],
      };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration ${iteration} skipped (no playbook) for ${competitionSlug}`,
        JSON.stringify(payload, null, 2),
        'kaggle.implementer.kernel-result',
      );
      return { completed: true, summaryProse: reason };
    }

    if (!playbook.solverTemplate) {
      const reason = `Playbook ${playbook.name} matched but provides no solverTemplate (set examples.solverTemplateFragmentKey to a prompt fragment). Skipping push.`;
      log(reason);
      const payload = {
        competitionId: competitionSlug,
        iteration,
        strategyLabel,
        playbookId: playbook.skillId,
        kernelStatus: 'skipped',
        failureMessage: reason,
        history: [...history, { iteration, label: strategyLabel, status: 'skipped' }],
      };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration ${iteration} skipped (no solverTemplate) for ${competitionSlug}`,
        JSON.stringify(payload, null, 2),
        'kaggle.implementer.kernel-result',
      );
      return { completed: true, summaryProse: reason };
    }

    const creds = resolveCreds(opts);
    const ownerSlug = creds.username.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const stamp = Date.now().toString(36);
    const kernelSlug = `wi-${competitionSlug}-it${iteration}-${stamp}`.slice(0, 60);
    const fullKernelSlug = `${ownerSlug}/${kernelSlug}`;
    const kernelTitle = `wi ${competitionSlug} it${iteration} ${stamp}`.slice(0, 50);
    const scriptSource = playbook.solverTemplate;

    log(
      `Implementer pushing kernel ${fullKernelSlug} (iteration ${iteration}, preset ${strategyLabel}, ` +
        `playbook ${playbook.name})`,
    );
    let kernelRef = '';
    let kernelUrl = '';
    let pushStatus = 'unknown';
    let pushError: string | null = null;
    try {
      const pushResult = await adapter.pushKernel(creds, {
        slug: fullKernelSlug,
        title: kernelTitle,
        source: scriptSource,
        kernelType: 'script',
        language: 'python',
        isPrivate: true,
        enableInternet: false,
        enableGpu: false,
        competitionSource: competitionSlug,
      });
      kernelRef = normalizeKernelRef(pushResult.ref, pushResult.url);
      kernelUrl = pushResult.url;
      pushStatus = pushResult.status;
      pushError = pushResult.errorMessage;
      log(`Push ok ref=${kernelRef} url=${kernelUrl} status=${pushStatus}`);
    } catch (err) {
      pushError = err instanceof Error ? err.message : String(err);
      log(`Push failed: ${pushError}`);
    }

    let runStatus = pushStatus;
    let failureMessage: string | null = pushError;
    let logExcerpt = '';
    let outputFiles: string[] = [];
    if (kernelRef && !pushError) {
      const opDefaults = await getOpDefaults();
      const pollIntervalMs =
        (playbook.config.pollIntervalSec ?? 0) > 0
          ? (playbook.config.pollIntervalSec as number) * 1000
          : opDefaults.pollIntervalMs;
      const pollTimeoutMs =
        (playbook.config.pollTimeoutSec ?? 0) > 0
          ? (playbook.config.pollTimeoutSec as number) * 1000
          : opDefaults.pollTimeoutMs;
      const polled = await pollKernelUntilTerminal(adapter, creds, kernelRef, log, pollIntervalMs, pollTimeoutMs);
      runStatus = polled.status;
      failureMessage = polled.failureMessage ?? failureMessage;
      logExcerpt = polled.logExcerpt;
      outputFiles = polled.outputFiles;
    }

    const updatedHistory = [...history, { iteration, label: strategyLabel, status: runStatus }];
    const payload = {
      competitionId: competitionSlug,
      title: approach['title'] ?? '',
      metric: approach['metric'] ?? 'unknown',
      iteration,
      maxIterations: Number(approach['maxIterations']) || playbook.config.maxIterations || DEFAULT_MAX_ITERATIONS,
      playbookId: playbook.skillId,
      playbookName: playbook.name,
      strategyLabel,
      // Forward the submission contract so the validator picks the right
      // branch (PATH A kernel_emits_file vs PATH B kernel_is_submission).
      submissionWriter: playbook.config.submissionWriter ?? null,
      submissionFormat: playbook.config.submissionFormat ?? null,
      submissionFilename: playbook.config.submissionFilename ?? null,
      kernelRef,
      kernelUrl,
      kernelStatus: runStatus,
      failureMessage,
      outputFiles,
      logExcerpt,
      history: updatedHistory,
    };
    await emitToNextAgent(
      context,
      'validator',
      `Iteration ${iteration} kernel result for ${competitionSlug}`,
      JSON.stringify(payload, null, 2),
      'kaggle.implementer.kernel-result',
    );
    return {
      completed: true,
      summaryProse: `Iteration ${iteration} kernel ${kernelRef || '(push failed)'} status=${runStatus}; forwarded to validator.`,
    };
  };
}
