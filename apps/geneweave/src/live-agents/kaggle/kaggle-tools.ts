/**
 * Kaggle tools — exposes the live Kaggle adapter as a `weaveAgent` ToolRegistry.
 *
 * These tools let an LLM-driven agent (the Kaggle Strategist) drive the entire
 * competition pipeline through a ReAct loop: discover competitions, inspect
 * one, push kernels, poll status, fetch logs, iterate.
 *
 * Tools intentionally OMIT submission. Submitting to Kaggle is gated on
 * dual-control human approval and is not exposed here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import {
  weaveToolRegistry as createToolRegistry,
  weaveTool as defineTool,
  type Tool,
  type ToolRegistry,
} from '@weaveintel/core';
import {
  liveKaggleAdapter,
  safeFetchKaggleOutputText,
  validateSubmissionCsv,
  wrapAdapterWithResilience,
  KaggleRateLimitError,
  type KaggleAdapter,
  type KaggleCredentials,
} from '../../kaggle/index.js';

/**
 * Resolve Kaggle credentials from KAGGLE_USERNAME / KAGGLE_KEY env vars.
 * Throws a clear error if either is missing. Called lazily at tool-execute
 * time so the kaggle tools can be registered in `tool_catalog` at boot even
 * when the host process has no kaggle creds (e.g. local dev without
 * `.env`). Tools that aren't invoked won't crash.
 */
export function resolveKaggleCredsFromEnv(): KaggleCredentials {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing: set KAGGLE_USERNAME and KAGGLE_KEY in env to invoke kaggle_* tools.',
    );
  }
  return { username, key };
}

export interface KaggleToolDefaults {
  /** Default `timeoutSeconds` for `kaggle_wait_for_kernel`. Default 300. */
  defaultWaitTimeoutSec?: number;
  /** Hard cap on `timeoutSeconds`. Default 600. */
  maxWaitTimeoutSec?: number;
  /** Default `pollIntervalSeconds` for `kaggle_wait_for_kernel`. Default 10. */
  defaultPollIntervalSec?: number;
  /** Bytes of head retained in `kaggle_get_kernel_output`. Default 4000. */
  outputHeadBytes?: number;
  /** Bytes of tail retained in `kaggle_get_kernel_output`. Default 4000. */
  outputTailBytes?: number;
}

export interface KaggleToolsOptions {
  /** Override the Kaggle HTTP adapter. Defaults to `liveKaggleAdapter`. */
  adapter?: KaggleAdapter;
  /** Pin credentials. When omitted they are resolved lazily from env on each
   *  tool execution via `resolveKaggleCredsFromEnv()`. */
  credentials?: KaggleCredentials;
  /** Operational defaults sourced from the catch-all (or matched) playbook
   *  config in DB. All fields fall back to the historical hard-coded values
   *  when omitted, so test/example call sites can keep ignoring this. */
  defaults?: KaggleToolDefaults;
  /** Local directory where every successful `kaggle_push_kernel` writes a
   *  `.py` copy of the kernel source plus a sibling `.json` with the kernel
   *  ref + URL + competition. Lets the operator grab the raw script for
   *  manual submission inspection without round-tripping through Kaggle.
   *  Defaults to `KAGGLE_ARTIFACT_DIR` env var, then `./kaggle-artifacts`. */
  artifactDir?: string;
  /** Hard cap on `kaggle_push_kernel` invocations within a single tick. The
   *  counter is scoped to this `createKaggleTools` instance, and because
   *  `prepare()` (in strategist-agent.ts) builds a fresh registry every tick,
   *  the cap is naturally per-tick per-agent. Concurrent runs each get their
   *  own counter. When omitted the cap is unbounded (back-compat for tests).
   *  When the cap is exceeded the tool returns a structured JSON rejection
   *  (NOT a throw) so the ReAct loop can react gracefully and pivot to
   *  `kaggle_wait_for_kernel` / `kaggle_get_kernel_output`.
   *
   *  Default in production is 1 (set by the strategist `prepare()`); raise
   *  per playbook only when an exploratory phase legitimately needs >1 push
   *  per tick (rare — Kaggle queues kernels serially and the agentic
   *  handoff only forwards the LAST kernel to the validator). */
  maxKernelPushesPerTick?: number;
  /** Best-effort observer invoked after every successful `kaggle_push_kernel`
   *  with the canonical Kaggle-returned `kernelRef` plus the metadata the
   *  strategist needs to keep straight (versionNumber, requestedSlug/title,
   *  codeBytes, pushedAt). The strategist wires this to persist a row into
   *  `kgl_run_event` (kind=`kernel_pushed`) so we have a queryable ledger of
   *  exactly which kernels were pushed for each run — instead of relying on
   *  unstructured tool_audit_events.output_preview JSON. Throws are swallowed
   *  by the tool; a failing observer never blocks the push response. */
  onKernelPushed?: (record: KernelPushRecord) => Promise<void> | void;
  /** Best-effort observer invoked the FIRST time any kaggle_* tool returns a
   *  structured `rate_limited` rejection within a tick. Wired by the
   *  heartbeat boot path to insert a `kgl_run_event` (kind=`tool_blocked`)
   *  so the operator can see in the run-detail UI that the tick was deferred
   *  by Kaggle account pressure (not by an LLM bug). Throws are swallowed —
   *  a failing observer never blocks the response. Subsequent rejections in
   *  the same tick are silenced to keep the ledger readable; the deduper is
   *  reset per `createKaggleTools` instance (i.e. once per tick per agent). */
  onToolBlocked?: (record: ToolBlockedRecord) => Promise<void> | void;
}

/** Structured record passed to `KaggleToolsOptions.onToolBlocked` the first
 *  time a kaggle_* tool returns a `rate_limited` rejection within a tick. */
export interface ToolBlockedRecord {
  toolName: string;
  reason: 'rate_limited';
  account: string;
  retryAfterSeconds: number;
  breakerOpen: boolean;
  message: string;
  blockedAt: string;
  meshId?: string;
  agentId?: string;
}

/** Structured record passed to `KaggleToolsOptions.onKernelPushed` after a
 *  successful `kaggle_push_kernel`. The `kernelRef` field is the EXACT,
 *  canonical Kaggle-returned ref (already normalized) — never a fabricated
 *  or LLM-derived value. */
export interface KernelPushRecord {
  kernelRef: string;
  kernelUrl: string;
  versionNumber: number | null | undefined;
  competitionRef: string;
  requestedSlug: string;
  requestedTitle: string;
  codeBytes: number;
  pushedAt: string;
  meshId?: string;
  agentId?: string;
  localArtifactPath?: string;
  localArtifactError?: string;
}

/** Strip whatever the LLM passed (slug, ref, URL) down to `<owner>/<slug>` or just `<slug>`. */
function normalizeCompetitionRef(value: string): string {
  if (!value) return '';
  const m = value.match(/competitions\/([^/?#]+)/);
  if (m && m[1]) return m[1];
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeKernelRef(value: string): string {
  if (!value) return '';
  // Kaggle returns `/code/<owner>/<slug>` from push; status/output need `<owner>/<slug>`.
  return value.replace(/^\/+(code\/)?/, '').replace(/\/+$/, '');
}

export function createKaggleTools(opts: KaggleToolsOptions = {}): ToolRegistry {
  const adapter: KaggleAdapter = wrapAdapterWithResilience(opts.adapter ?? liveKaggleAdapter);
  const getCreds = (): KaggleCredentials => opts.credentials ?? resolveKaggleCredsFromEnv();
  const defaults = opts.defaults ?? {};
  const defaultWaitTimeoutSec = defaults.defaultWaitTimeoutSec ?? 300;
  const maxWaitTimeoutSec = defaults.maxWaitTimeoutSec ?? 600;
  const defaultPollIntervalSec = defaults.defaultPollIntervalSec ?? 10;
  const outputHeadBytes = defaults.outputHeadBytes ?? 4000;
  const outputTailBytes = defaults.outputTailBytes ?? 4000;
  const artifactDir = pathResolve(
    opts.artifactDir ?? process.env['KAGGLE_ARTIFACT_DIR'] ?? './kaggle-artifacts',
  );
  // Per-tick push counter. Closure-scoped to this createKaggleTools call
  // (one instance per prepare() per tick), so concurrent runs are isolated.
  const maxPushesPerTick = opts.maxKernelPushesPerTick;
  let pushesThisTick = 0;
  const lastPushedKernels: Array<{ kernelRef: string; slug: string }> = [];

  // Per-tick rate-limit state (Gap #1/#3). When any kaggle_* tool surfaces
  // a structured `KaggleRateLimitError`, we (a) flip `tickBlocked=true` so
  // every subsequent kaggle_* call this tick short-circuits with the same
  // structured "yield this turn" JSON, and (b) emit ONE `tool_blocked`
  // observer call so the operator-facing kgl_run_event ledger gets a single
  // row per tick (not one per repeated tool call). The LLM, seeing the same
  // deterministic JSON twice, terminates the ReAct loop with its final
  // summary instead of thrashing on the same 429 — which lets the heartbeat
  // scheduler's existing per-agent backoff machinery defer subsequent ticks
  // (`agent_backoff` event) until the per-account quota window drains.
  let tickBlocked = false;
  let tickBlockedDetail:
    | { account: string; retryAfterSeconds: number; breakerOpen: boolean; message: string }
    | null = null;
  let blockedObserverFired = false;
  const perToolErrorCounts = new Map<string, number>();
  const PER_TOOL_REPEAT_THRESHOLD = 2;

  function rateLimitedEnvelope(toolName: string, err: KaggleRateLimitError): string {
    return JSON.stringify({
      error: 'rate_limited',
      tool: toolName,
      account: err.username,
      retryAfterSeconds: err.retryAfterSeconds,
      breakerOpen: err.breakerOpen,
      message:
        `Kaggle account "${err.username}" is rate-limited (retryAfter=${err.retryAfterSeconds}s, ` +
        `circuitBreakerOpen=${err.breakerOpen}). STOP calling kaggle_* tools this turn. ` +
        `Return your final summary now — the supervisor will retry on the next scheduled tick ` +
        `after the per-account quota window drains. Do not change the slug or retry; the ` +
        `breaker is account-scoped and the next call will hit the same rejection.`,
    });
  }

  function tickBlockedEnvelope(toolName: string): string {
    const d = tickBlockedDetail;
    return JSON.stringify({
      error: 'tick_blocked',
      tool: toolName,
      account: d?.account ?? '<unknown>',
      retryAfterSeconds: d?.retryAfterSeconds ?? 0,
      message:
        `Kaggle tools are disabled for the rest of this turn — account "${d?.account ?? '?'}" ` +
        `was rate-limited earlier this tick. Stop calling kaggle_* tools and return your final ` +
        `summary now. The supervisor will retry on the next scheduled tick.`,
    });
  }

  function repeatedErrorEnvelope(toolName: string, count: number): string {
    return JSON.stringify({
      error: 'tool_circuit_local',
      tool: toolName,
      consecutiveErrorsThisTick: count,
      message:
        `Tool ${toolName} has failed ${count} times this turn with the same error. ` +
        `Stop retrying — return your final summary now and the supervisor will reschedule.`,
    });
  }

  async function fireToolBlockedObserver(toolName: string, err: KaggleRateLimitError): Promise<void> {
    if (blockedObserverFired || !opts.onToolBlocked) return;
    blockedObserverFired = true;
    try {
      await opts.onToolBlocked({
        toolName,
        reason: 'rate_limited',
        account: err.username,
        retryAfterSeconds: err.retryAfterSeconds,
        breakerOpen: err.breakerOpen,
        message: err.message,
        blockedAt: new Date().toISOString(),
      });
    } catch {
      // intentionally swallowed
    }
  }

  /**
   * Wrap a tool's `invoke()` so that:
   *   1. If the tick is already blocked → return tick_blocked envelope immediately.
   *   2. If the inner call throws KaggleRateLimitError → record block, fire
   *      observer (once per tick), return rate_limited envelope.
   *   3. Track per-tool repeat-error count; after PER_TOOL_REPEAT_THRESHOLD
   *      identical rate_limited responses, return tool_circuit_local envelope.
   *   4. Other errors propagate unchanged (back-compat with existing
   *      handler-side error paths).
   */
  function wrapInvokeWithRateLimitGuard(tool: Tool): Tool {
    const toolName = tool.schema.name;
    const originalInvoke = tool.invoke.bind(tool);
    return {
      schema: tool.schema,
      async invoke(ctx, input) {
        if (tickBlocked) {
          const count = (perToolErrorCounts.get(toolName) ?? 0) + 1;
          perToolErrorCounts.set(toolName, count);
          if (count >= PER_TOOL_REPEAT_THRESHOLD) {
            return { content: repeatedErrorEnvelope(toolName, count) };
          }
          return { content: tickBlockedEnvelope(toolName) };
        }
        try {
          return await originalInvoke(ctx, input);
        } catch (err) {
          if (err instanceof KaggleRateLimitError) {
            tickBlocked = true;
            tickBlockedDetail = {
              account: err.username,
              retryAfterSeconds: err.retryAfterSeconds,
              breakerOpen: err.breakerOpen,
              message: err.message,
            };
            await fireToolBlockedObserver(toolName, err);
            return { content: rateLimitedEnvelope(toolName, err) };
          }
          throw err;
        }
      },
    };
  }

  const innerReg = createToolRegistry();
  // Public registry — every register() call wraps the tool's invoke() with
  // the rate-limit guard before delegating to the inner registry. This
  // keeps every tool definition below unchanged while ensuring there is a
  // single, mandatory choke point for KaggleRateLimitError handling.
  const reg: ToolRegistry = {
    register(tool: Tool) {
      innerReg.register(wrapInvokeWithRateLimitGuard(tool));
    },
    unregister: innerReg.unregister.bind(innerReg),
    get: innerReg.get.bind(innerReg),
    list: innerReg.list.bind(innerReg),
    listByTag: innerReg.listByTag.bind(innerReg),
    toDefinitions: innerReg.toDefinitions.bind(innerReg),
  };

  reg.register(
    defineTool({
      name: 'kaggle_list_competitions',
      description:
        'List active Kaggle competitions. Returns up to 20 competitions with id, title, evaluation metric, deadline, and reward. Use to find a competition to work on.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'number', description: 'Page index (default 1)' },
          search: { type: 'string', description: 'Optional substring search.' },
        },
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const page = (args['page'] as number | undefined) ?? 1;
        const search = args['search'] as string | undefined;
        const list = await adapter.listCompetitions(getCreds(), { page, search });
        return JSON.stringify(
          list.slice(0, 20).map((c) => ({
            id: c.id,
            title: c.title,
            evaluationMetric: c.evaluationMetric,
            deadline: c.deadline,
            reward: c.reward,
            category: c.category,
          })),
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_competition',
      description:
        'Fetch the full description, evaluation metric, deadline, and metadata of a single Kaggle competition. Always call this once before planning a kernel.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Competition slug, e.g. arc-prize-2026-arc-agi-3.' } },
        required: ['ref'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const c = await adapter.getCompetition(getCreds(), ref);
        return JSON.stringify(c, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_list_competition_files',
      description:
        'List the data files Kaggle will mount at /kaggle/input/<slug>/ for a competition. Returns name, size (bytes), and creationDate.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Competition slug.' } },
        required: ['ref'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const files = await adapter.listCompetitionFiles(getCreds(), ref);
        return JSON.stringify(files, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_competition_file',
      description:
        "Download a single small text file (README.md, agents.md, llms.txt, sample_submission.csv/.json/.py, etc.) from a Kaggle competition's data bundle WITHOUT pushing a kernel. Use this in Phase 1 to learn the competition's submission contract — the required filename, format (CSV/JSON/Python script), expected columns, or framework conventions. Returns { fileName, sizeBytes, truncated, binary, content }. Content is truncated at 64 KiB. Binary files return a hex preview only.",
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Competition slug.' },
          fileName: { type: 'string', description: 'Exact file name as returned by kaggle_list_competition_files (e.g. README.md, agents.md, sample_submission.csv).' },
          maxBytes: { type: 'number', description: 'Optional truncation cap. Default 65536.' },
        },
        required: ['ref', 'fileName'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const fileName = String(args['fileName'] ?? '').trim();
        if (!fileName) return JSON.stringify({ error: 'fileName is required' });
        const maxBytes = (args['maxBytes'] as number | undefined) ?? 65536;
        try {
          const out = await adapter.downloadCompetitionFile(getCreds(), ref, fileName, { maxBytes });
          return JSON.stringify(out, null, 2);
        } catch (err) {
          return JSON.stringify({
            error: 'download_failed',
            fileName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_competition_overview',
      description:
        "Fetch the competition's full public narrative — Overview, Evaluation, Rules, Data, Timeline — as plain text. " +
        'Use in Phase 0 alongside README.md/agents.md to build the SUBMISSION CONTRACT. For simulation/agent ' +
        'competitions (e.g. orbit-wars) the actual game rules, scoring math (e.g. Gaussian skill ratings, mirror ' +
        'symmetry), observation schema, action schema, and per-turn timeouts live HERE — not in /kaggle/input/ files. ' +
        'Returns { competitionRef, pages: [{ slug, title, content, source, bytes, truncated }], combinedText, ' +
        'truncated, missing }. Per-page content is capped at ~8 KiB and combined text at ~24 KiB by default.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Competition slug, e.g. orbit-wars.' },
          pageSlugs: {
            type: 'array',
            description: 'Optional subset of page slugs. Default: overview, evaluation, rules, data, timeline.',
            items: { type: 'string' },
          },
          maxBytesPerPage: { type: 'number', description: 'Per-page truncation cap. Default 8192.' },
          combinedMaxBytes: { type: 'number', description: 'Combined text truncation cap. Default 24576.' },
        },
        required: ['ref'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const pageSlugs = Array.isArray(args['pageSlugs'])
          ? (args['pageSlugs'] as unknown[]).map(String)
          : undefined;
        const maxBytesPerPage = typeof args['maxBytesPerPage'] === 'number' ? (args['maxBytesPerPage'] as number) : undefined;
        const combinedMaxBytes = typeof args['combinedMaxBytes'] === 'number' ? (args['combinedMaxBytes'] as number) : undefined;
        try {
          const out = await adapter.getCompetitionOverview(getCreds(), ref, {
            ...(pageSlugs ? { pageSlugs } : {}),
            ...(maxBytesPerPage !== undefined ? { maxBytesPerPage } : {}),
            ...(combinedMaxBytes !== undefined ? { combinedMaxBytes } : {}),
          });
          return JSON.stringify(out, null, 2);
        } catch (err) {
          return JSON.stringify({
            error: 'overview_fetch_failed',
            ref,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_push_kernel',
      description:
        "Create or update a private Python kernel on Kaggle and run it. Provide the full Python source as `code`. The kernel will mount the competition data at /kaggle/input/<slug>/. Returns { kernelRef, kernelUrl } — use kernelRef for status and output calls.",
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Short kebab-case slug for the kernel (3-40 chars).' },
          title: { type: 'string', description: 'Human-readable kernel title.' },
          competitionRef: { type: 'string', description: 'Competition slug to attach as a data source.' },
          code: { type: 'string', description: 'Full Python script to run.' },
        },
        required: ['slug', 'title', 'competitionRef', 'code'],
      },
      tags: ['kaggle', 'write'],
      riskLevel: 'external-side-effect',
      execute: async (args) => {
        const slug = (args['slug'] as string).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        const title = args['title'] as string;
        const competitionRef = normalizeCompetitionRef(args['competitionRef'] as string);
        const code = args['code'] as string;
        // Guard: refuse empty / trivially-small kernel pushes. The strategist
        // sometimes drops the source string under context-window pressure and
        // ends up pushing zero-byte kernels. Force it to re-emit instead of
        // silently shipping an empty notebook.
        const codeBytes = Buffer.byteLength(code ?? '', 'utf8');
        if (codeBytes < 200) {
          return JSON.stringify({
            error: 'empty_or_tiny_source',
            codeBytes,
            message:
              'kaggle_push_kernel rejected: source code is empty or under 200 bytes. ' +
              'Re-emit the FULL Python script in the `code` argument and call this tool again. ' +
              'Do NOT retry with the same empty source; do NOT change the slug to bypass this check.',
          });
        }
        // Per-tick push budget (set by strategist prepare() from playbook
        // config; default 1 in production). Hard cap — the LLM repeatedly
        // ignored prompt-level "AT MOST ONE push" rules and burned both
        // OpenAI tokens and Kaggle compute pushing 20+ near-identical
        // kernels per tick. The agentic handoff only forwards the LAST
        // kernel to the validator anyway, so extra pushes are pure waste.
        if (maxPushesPerTick !== undefined && pushesThisTick >= maxPushesPerTick) {
          return JSON.stringify({
            error: 'push_budget_exhausted',
            pushesThisTick,
            maxKernelPushesPerTick: maxPushesPerTick,
            previousKernels: lastPushedKernels,
            message:
              `kaggle_push_kernel rejected: already pushed ${pushesThisTick} kernel(s) this turn ` +
              `(cap=${maxPushesPerTick}). Call kaggle_wait_for_kernel and kaggle_get_kernel_output ` +
              `for the previous kernel(s) listed above, then return your final response. The ` +
              `validator will bounce back and you can push the next kernel on the next tick.`,
          });
        }
        const creds = getCreds();
        const username = creds.username;
        // Kaggle returns 409 Conflict when a notebook title (or slug) already
        // exists on the account. The strategist often re-uses titles like
        // "ARC-AGI-3 Scout - Iteration 1" across runs, so first try the
        // requested title/slug; if that 409s, retry once with a short
        // timestamp suffix that guarantees uniqueness without losing the
        // operator-facing label.
        const tryPush = async (s: string, t: string) =>
          adapter.pushKernel(creds, {
            slug: `${username}/${s}`,
            title: t,
            language: 'python',
            kernelType: 'script',
            isPrivate: true,
            enableGpu: false,
            enableInternet: false,
            competitionSource: competitionRef,
            source: code,
          });
        let result;
        try {
          result = await tryPush(slug, title);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/\b409\b/.test(msg)) throw err;
          const suffix = `-${Date.now().toString(36).slice(-5)}`;
          const slug2 = `${slug.slice(0, 40 - suffix.length)}${suffix}`;
          const title2 = `${title.slice(0, 50 - suffix.length)}${suffix}`;
          result = await tryPush(slug2, title2);
        }
        const kernelRef = normalizeKernelRef(result.ref);
        // Persist the source as a local .py so the operator has a single
        // file to download/inspect/upload manually for SHAPE B competitions
        // (where the kernel itself IS the submission). Best-effort — never
        // blocks the push response.
        let artifactPath: string | undefined;
        let artifactError: string | undefined;
        try {
          mkdirSync(artifactDir, { recursive: true });
          const compDir = join(artifactDir, competitionRef || 'unknown');
          mkdirSync(compDir, { recursive: true });
          const safeRef = kernelRef.replace(/[^a-zA-Z0-9._-]/g, '__');
          const verSuffix = result.versionNumber ? `__v${result.versionNumber}` : '';
          const baseName = `${safeRef}${verSuffix}__${Date.now().toString(36)}`;
          const pyPath = join(compDir, `${baseName}.py`);
          const metaPath = join(compDir, `${baseName}.json`);
          writeFileSync(pyPath, code, 'utf8');
          writeFileSync(
            metaPath,
            JSON.stringify(
              {
                kernelRef,
                kernelUrl: result.url,
                versionNumber: result.versionNumber,
                competitionRef,
                title,
                slug,
                pushedAt: new Date().toISOString(),
                codeBytes,
                pyPath,
              },
              null,
              2,
            ),
            'utf8',
          );
          artifactPath = pyPath;
        } catch (err) {
          artifactError = err instanceof Error ? err.message : String(err);
        }
        // Best-effort: notify the strategist-supplied observer so it can
        // persist a structured row into the run-event ledger. Swallow
        // throws — a failing observer must never block the push response.
        // Guard: only fire when we have a non-empty kernelRef AND the
        // adapter returned a non-empty `result.ref`. This prevents the
        // observer from persisting empty/zero rows when a push 4xx-failed
        // partway through (e.g. Kaggle returned a body without a slug).
        if (opts.onKernelPushed && kernelRef && result.ref) {
          try {
            await opts.onKernelPushed({
              kernelRef,
              kernelUrl: result.url,
              versionNumber: result.versionNumber,
              competitionRef,
              requestedSlug: slug,
              requestedTitle: title,
              codeBytes,
              pushedAt: new Date().toISOString(),
              ...(artifactPath ? { localArtifactPath: artifactPath } : {}),
              ...(artifactError ? { localArtifactError: artifactError } : {}),
            });
          } catch {
            // intentionally swallowed
          }
        }
        // Successful push — increment the per-tick counter and remember
        // the ref so the next over-budget rejection can name it explicitly.
        if (kernelRef && result.ref) {
          pushesThisTick += 1;
          lastPushedKernels.push({ kernelRef, slug });
        }
        return JSON.stringify(
          {
            kernelRef,
            kernelUrl: result.url,
            versionNumber: result.versionNumber,
            ...(artifactPath ? { localArtifactPath: artifactPath } : {}),
            ...(artifactError ? { localArtifactError: artifactError } : {}),
          },
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_kernel_status',
      description:
        "Get the current status of a kernel (queued|running|complete|error|cancelRequested|cancelAcknowledged). Use kernelRef from kaggle_push_kernel.",
      parameters: {
        type: 'object',
        properties: { kernelRef: { type: 'string', description: 'owner/slug returned from kaggle_push_kernel.' } },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const status = await adapter.getKernelStatus(getCreds(), ref);
        return JSON.stringify(status, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_wait_for_kernel',
      description:
        'Poll the kernel status until it reaches a terminal state (complete/error/cancelled) or the timeout elapses. Returns the final status object.',
      parameters: {
        type: 'object',
        properties: {
          kernelRef: { type: 'string' },
          timeoutSeconds: { type: 'number', description: 'Max time to wait. Default 300, max 600.' },
          pollIntervalSeconds: { type: 'number', description: 'Poll interval. Default 10.' },
        },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const timeoutMs =
          Math.min(((args['timeoutSeconds'] as number | undefined) ?? defaultWaitTimeoutSec), maxWaitTimeoutSec) * 1000;
        const intervalMs = Math.max(((args['pollIntervalSeconds'] as number | undefined) ?? defaultPollIntervalSec), 5) * 1000;
        const deadline = Date.now() + timeoutMs;
        const terminal = new Set(['complete', 'error', 'cancelAcknowledged', 'cancelRequested']);
        let last: unknown = null;
        while (Date.now() < deadline) {
          const status = await adapter.getKernelStatus(getCreds(), ref);
          last = status;
          const s = (status as { status?: string }).status ?? '';
          if (terminal.has(s)) return JSON.stringify({ ...status, terminal: true }, null, 2);
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        return JSON.stringify({ ...(last as object), terminal: false, timedOut: true }, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_kernel_output',
      description:
        'Fetch the kernel log and list of output files after it has finished. Returns { logExcerpt, outputFiles[] }.',
      parameters: {
        type: 'object',
        properties: { kernelRef: { type: 'string' } },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const out = await adapter.getKernelOutput(getCreds(), ref);
        // Many kernels print critical info (file inventory, framework READMEs)
        // EARLY in the log and the failure trace LATE. Naive trailing-only
        // truncation drops the inventory. Keep both ends.
        const raw = (out as { log?: string }).log ?? '';
        // Some Kaggle responses return a JSON-array-of-stream-events string;
        // flatten to plain stdout/stderr text first.
        let log = raw;
        if (raw.startsWith('[') && raw.includes('"stream_name"')) {
          try {
            const events = JSON.parse(raw) as Array<{ stream_name?: string; data?: string }>;
            log = events.map((e) => e.data ?? '').join('');
          } catch {
            /* fall back to raw */
          }
        }
        const HEAD = outputHeadBytes;
        const TAIL = outputTailBytes;
        const display = log.length > HEAD + TAIL + 200
          ? `${log.slice(0, HEAD)}\n\n...[${log.length - HEAD - TAIL} chars truncated]...\n\n${log.slice(-TAIL)}`
          : log;
        // Inline the contents of small JSON output files (cv_scores.json,
        // metrics.json, scores.json) so the strategist can read actual CV
        // numbers between iterations instead of just seeing a signed URL with
        // size=0 metadata. Without this, "iterate based on CV" is impossible.
        const outFiles = ((out as { files?: Array<{ fileName?: string; url?: string }> }).files ?? []);
        const inlinedContents: Record<string, unknown> = {};
        const inlinedCsvFiles: Record<string, string> = {};
        const SCORE_FILE_RE = /^(cv_scores?|metrics?|scores?|results?)\.json$/i;
        // Skill-driven validator needs to read the actual submission.csv bytes
        // (header line + row count + IDs) without operator handholding. Inline
        // any small submission*.csv so kaggle_validate_submission can consume
        // it directly from this tool's output. 4 MiB is generous enough for
        // ~250k-row Kaggle submissions and small enough to keep tool returns
        // in the model's context budget.
        const CSV_FILE_RE = /^submission([_-].*)?\.csv$/i;
        const MAX_CSV_INLINE = 4 * 1024 * 1024;
        for (const f of outFiles) {
          const name = f.fileName ?? '';
          const url = f.url ?? '';
          if (!name || !url) continue;
          if (SCORE_FILE_RE.test(name)) {
            const text = await safeFetchKaggleOutputText(url, { maxBytes: 8192 });
            if (text === null) continue;
            try {
              inlinedContents[name] = JSON.parse(text);
            } catch {
              inlinedContents[name] = text;
            }
          } else if (CSV_FILE_RE.test(name)) {
            const text = await safeFetchKaggleOutputText(url, { maxBytes: MAX_CSV_INLINE });
            if (text === null) continue;
            inlinedCsvFiles[name] = text;
          }
        }
        const enriched: Record<string, unknown> = { ...(out as object), log: display };
        if (Object.keys(inlinedContents).length > 0) {
          enriched['inlinedScoreFiles'] = inlinedContents;
        }
        if (Object.keys(inlinedCsvFiles).length > 0) {
          enriched['inlinedCsvFiles'] = inlinedCsvFiles;
        }
        return JSON.stringify(enriched, null, 2);
      },
    }),
  );
  // Skill-driven submission validator. The kaggle_validator skill drives the
  // workflow:
  //   1. kaggle_list_competition_files → find sample_submission.* (or
  //      gender_submission.csv for Titanic)
  //   2. kaggle_get_competition_file → read the sample's header + row count
  //   3. kaggle_get_kernel_output → pull the kernel's submission.csv via
  //      `inlinedCsvFiles`
  //   4. kaggle_validate_submission → deterministic header / row / id parity
  //      checks against the sample
  // Pure compute, no network, no credentials.
  reg.register(
    defineTool({
      name: 'kaggle_validate_submission',
      description:
        'Deterministically validate a Kaggle submission CSV against the competition sample. Performs header-order match, row-count parity, ID uniqueness and ID coverage checks (when expectedIds supplied). Returns { valid, rows, headers, errors, warnings }. Pure TypeScript — no network, no credentials. Call BEFORE handing off to the submitter.',
      parameters: {
        type: 'object',
        properties: {
          csvContent: {
            type: 'string',
            description: 'Full submission CSV bytes as a string (typically taken from kaggle_get_kernel_output.inlinedCsvFiles["submission.csv"]).',
          },
          expectedHeaders: {
            type: 'array',
            items: { type: 'string' },
            description: 'Expected column headers in the exact order Kaggle requires. Read from the first line of the competition sample submission.',
          },
          expectedRowCount: {
            type: 'number',
            description: 'Expected number of data rows (total lines in sample_submission - 1). Optional but strongly recommended.',
          },
          idColumn: {
            type: 'string',
            description: 'Name of the ID column (typically the first column in expectedHeaders). When set, ID uniqueness is enforced.',
          },
          expectedIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'When supplied, enforces that the submission ID set equals this set (no missing, no extra). Read from sample_submission column.',
          },
          maxBytes: {
            type: 'number',
            description: 'Maximum CSV size in bytes (default 100 MiB).',
          },
        },
        required: ['csvContent', 'expectedHeaders'],
      },
      tags: ['kaggle', 'read', 'local'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const csvContent = String(args['csvContent'] ?? '');
        const expectedHeaders = (args['expectedHeaders'] as string[] | undefined) ?? [];
        if (!csvContent) {
          return JSON.stringify({ valid: false, rows: 0, headers: [], errors: ['csvContent is empty'], warnings: [] });
        }
        if (!Array.isArray(expectedHeaders) || expectedHeaders.length === 0) {
          return JSON.stringify({ valid: false, rows: 0, headers: [], errors: ['expectedHeaders is required and must be non-empty'], warnings: [] });
        }
        const input: Parameters<typeof validateSubmissionCsv>[0] = {
          csvContent,
          expectedHeaders,
        };
        if (typeof args['expectedRowCount'] === 'number') input.expectedRowCount = args['expectedRowCount'] as number;
        if (typeof args['idColumn'] === 'string') input.idColumn = args['idColumn'] as string;
        if (Array.isArray(args['expectedIds'])) input.expectedIds = args['expectedIds'] as string[];
        if (typeof args['maxBytes'] === 'number') input.maxBytes = args['maxBytes'] as number;
        try {
          const result = validateSubmissionCsv(input);
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return JSON.stringify({
            valid: false,
            rows: 0,
            headers: [],
            errors: [`validator_threw: ${err instanceof Error ? err.message : String(err)}`],
            warnings: [],
          });
        }
      },
    }),
  );
  return reg;
}

/**
 * Build a map of kaggle tools keyed by tool name (`kaggle_*`).
 *
 * Used by `BUILTIN_TOOLS` so kaggle tools are visible in `tool_catalog` and
 * can be bound to live-agent definitions via `live_agent_tool_bindings`.
 *
 * Credentials are resolved lazily from `KAGGLE_USERNAME` / `KAGGLE_KEY` at
 * the moment a tool is invoked, so this map can be constructed at startup
 * even if no kaggle creds are configured. Operators can still see the tools
 * in the admin panel and gate them through `tool_policies`.
 */
export function createKaggleToolMap(opts: KaggleToolsOptions = {}): Record<string, Tool> {
  const reg = createKaggleTools(opts);
  const map: Record<string, Tool> = {};
  for (const tool of reg.list()) map[tool.schema.name] = tool;
  return map;
}
