/**
 * Per-Agent Model Resolver — geneweave re-export shim.
 *
 * The canonical overlay is `weaveAgentOverlayResolver` from
 * `@weaveintel/live-agents-runtime`. This file re-exports it so geneweave
 * call sites can import without reaching across packages.
 *
 * The legacy imperative `resolveLiveAgentModel` helper and its
 * per-process cache (`_cache`, `clearLiveAgentModelCache`) were removed
 * in the Phase 8.1 audit pass — no in-tree callers remained, and
 * `examples/85-agent-model-routing.ts` was migrated to the overlay API.
 */

export {
  weaveAgentOverlayResolver,
  type WeaveAgentOverlayResolverOptions,
  type ModelResolvedAuditEvent,
} from '@weaveintel/live-agents-runtime';
