/**
 * Kaggle handler kinds — DB-registerable wrappers around the existing
 * `createXxxAgentic` / `createXxxDeterministic` factories.
 *
 * Phase A of the kaggle DB-driven migration. Each registered kind is a
 * `HandlerKindRegistration` whose `factory(ctx: HandlerContext)` returns the
 * underlying kaggle `TaskHandler` built from a process-singleton
 * `SharedHandlerContext`. Heavy deps (Kaggle adapter, credentials,
 * playbook resolver, DB) are captured at boot — they don't change between
 * ticks.
 *
 * Per-tick `HandlerContext` slots (`model`, `modelResolver`, `policy`,
 * `tools`) are accepted for parity with `agentic.react` but are NOT yet
 * consulted by the kaggle handlers; today those flow through
 * `KaggleRoleHandlersOptions` set once at supervisor boot. Phase C
 * (mesh provisioning via `weaveLiveMeshFromDb`) will start honoring per-tick
 * slots so operators can swap models / tool bindings per agent.
 *
 * Wiring:
 *   1. App boot constructs `KaggleRoleHandlersOptions` once (adapter, db,
 *      playbookResolver, plannerModel/modelResolver, policy).
 *   2. `registerKaggleHandlerKinds(registry, opts)` adds 10 named kinds to
 *      the shared `HandlerRegistry`.
 *   3. `live_agent_handler_bindings` rows reference these kinds by key.
 *   4. `weaveLiveMeshFromDb` uses the registry to build a `TaskHandler` for
 *      each agent at provisioning time.
 */

import { liveKaggleAdapter, wrapAdapterWithResilience } from '../../kaggle/index.js';
import type {
  HandlerContext,
  HandlerKindRegistration,
  HandlerRegistry,
} from '@weaveintel/live-agents-runtime';
import {
  loadOperationalDefaults,
  noopHandler,
  type KaggleRoleHandlersOptions,
  type OperationalDefaults,
  type SharedHandlerContext,
} from './handlers/_shared.js';
import { createDiscovererAgentic, createDiscovererDeterministic } from './handlers/discoverer.js';
import {
  createStrategistAgenticWithHandoff,
  createStrategistDeterministic,
} from './handlers/strategist.js';
import { createImplementerDeterministic } from './handlers/implementer.js';
import { createValidatorAgentic, createValidatorDeterministic } from './handlers/validator.js';
import { createSubmitter } from './handlers/submitter.js';
import { createObserverAgentic, createObserverDeterministic } from './handlers/observer.js';

/** Build the process-singleton SharedHandlerContext from boot options. */
function buildSharedCtx(opts: KaggleRoleHandlersOptions): SharedHandlerContext {
  const adapter = wrapAdapterWithResilience(opts.adapter ?? liveKaggleAdapter);
  const log = opts.log ?? ((m: string) => console.log(`[kaggle-handler] ${m}`));
  let opDefaultsPromise: Promise<OperationalDefaults> | null = null;
  const getOpDefaults = () => {
    if (!opDefaultsPromise) opDefaultsPromise = loadOperationalDefaults(opts.playbookResolver, log);
    return opDefaultsPromise;
  };
  return { opts, adapter, log, getOpDefaults };
}

/** Roles that require `opts.db` to function. Build a noop handler when missing. */
function requireDb<T>(opts: KaggleRoleHandlersOptions, build: () => T): T | typeof noopHandler {
  return opts.db ? build() : noopHandler;
}

/**
 * Build a Kaggle-specific factory wrapper. Ignores most of `HandlerContext`
 * today (closure carries everything); Phase C will start consuming
 * `ctx.modelResolver`, `ctx.policy`, and `ctx.tools`.
 */
function kaggleKind(
  kind: string,
  description: string,
  build: (sharedCtx: SharedHandlerContext) => ReturnType<typeof createDiscovererAgentic>,
  sharedCtx: SharedHandlerContext,
): HandlerKindRegistration {
  return {
    kind,
    description,
    configSchema: { type: 'object', properties: {} },
    factory: (_ctx: HandlerContext) => build(sharedCtx),
  };
}

/**
 * Register all kaggle handler kinds against the shared registry.
 *
 * Idempotent: kinds already registered (e.g. on a second boot or hot-reload)
 * are silently skipped rather than throwing. Call after `initHandlerRegistry()`
 * and before `syncHandlerKindsToDb()` so the new kinds reach the
 * `live_handler_kinds` table.
 */
export function registerKaggleHandlerKinds(
  registry: HandlerRegistry,
  opts: KaggleRoleHandlersOptions = {},
): void {
  const sharedCtx = buildSharedCtx(opts);
  const safeRegister = (reg: HandlerKindRegistration): void => {
    if (registry.resolve(reg.kind)) return;
    registry.register(reg);
  };

  // Discoverer ----------------------------------------------------------
  safeRegister(
    kaggleKind(
      'kaggle.discoverer.agentic',
      'Kaggle competition discoverer (LLM-driven). Pins the run to its competition_ref and seeds the strategist.',
      createDiscovererAgentic,
      sharedCtx,
    ),
  );
  safeRegister(
    kaggleKind(
      'kaggle.discoverer.deterministic',
      'Kaggle competition discoverer (no LLM). Pins to competition_ref and emits the structured seed JSON.',
      createDiscovererDeterministic,
      sharedCtx,
    ),
  );

  // Strategist ----------------------------------------------------------
  safeRegister(
    kaggleKind(
      'kaggle.strategist.agentic',
      'Kaggle approach strategist (LLM ReAct loop). Plans iterations, drives kaggle_* tools, hands off to the kernel author.',
      createStrategistAgenticWithHandoff,
      sharedCtx,
    ),
  );
  safeRegister(
    kaggleKind(
      'kaggle.strategist.deterministic',
      'Kaggle approach strategist (no LLM). Resolves a DB playbook by competition slug and forwards the strategy.',
      createStrategistDeterministic,
      sharedCtx,
    ),
  );

  // Implementer (Kernel Author) -----------------------------------------
  safeRegister(
    kaggleKind(
      'kaggle.implementer.deterministic',
      'Kaggle kernel author (no LLM). Renders the playbook code template and pushes a kernel.',
      createImplementerDeterministic,
      sharedCtx,
    ),
  );

  // Validator -----------------------------------------------------------
  safeRegister({
    kind: 'kaggle.validator.agentic',
    description:
      'Kaggle submission validator (LLM-driven). Reads kernel output, scores against the rubric, persists evidence. Requires opts.db.',
    configSchema: { type: 'object', properties: {} },
    factory: (_ctx: HandlerContext) => requireDb(opts, () => createValidatorAgentic(sharedCtx)),
  });
  safeRegister({
    kind: 'kaggle.validator.deterministic',
    description:
      'Kaggle submission validator (no LLM). Scores kernel output against the rubric purely from output files. Requires opts.db.',
    configSchema: { type: 'object', properties: {} },
    factory: (_ctx: HandlerContext) => requireDb(opts, () => createValidatorDeterministic(sharedCtx)),
  });

  // Submitter -----------------------------------------------------------
  safeRegister(
    kaggleKind(
      'kaggle.submitter',
      'Kaggle competition submitter. Submits a validated kernel output to the leaderboard. Gated on dual-control approval.',
      createSubmitter,
      sharedCtx,
    ),
  );

  // Observer ------------------------------------------------------------
  safeRegister({
    kind: 'kaggle.observer.agentic',
    description:
      'Kaggle leaderboard observer (LLM-driven). Polls the public leaderboard and surfaces ranking changes. Requires opts.db.',
    configSchema: { type: 'object', properties: {} },
    factory: (_ctx: HandlerContext) => requireDb(opts, () => createObserverAgentic(sharedCtx)),
  });
  safeRegister({
    kind: 'kaggle.observer.deterministic',
    description:
      'Kaggle leaderboard observer (no LLM). Polls the public leaderboard and persists rank deltas. Requires opts.db.',
    configSchema: { type: 'object', properties: {} },
    factory: (_ctx: HandlerContext) => requireDb(opts, () => createObserverDeterministic(sharedCtx)),
  });
}

/** Stable list of kaggle handler kind keys. Useful for seed scripts that
 *  want to validate the kaggle blueprint references only known kinds. */
export const KAGGLE_HANDLER_KINDS = [
  'kaggle.discoverer.agentic',
  'kaggle.discoverer.deterministic',
  'kaggle.strategist.agentic',
  'kaggle.strategist.deterministic',
  'kaggle.implementer.deterministic',
  'kaggle.validator.agentic',
  'kaggle.validator.deterministic',
  'kaggle.submitter',
  'kaggle.observer.agentic',
  'kaggle.observer.deterministic',
] as const;

export type KaggleHandlerKind = (typeof KAGGLE_HANDLER_KINDS)[number];
