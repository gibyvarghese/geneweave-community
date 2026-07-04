/**
 * Per-Agent Tool Registry — Phase 3 bridge.
 *
 * Glues the runtime-package tool binder to geneweave's existing
 * `createToolRegistry` factory in `apps/geneweave/src/tools.ts`. The result
 * is a fully policy-enforced, credential-aware `ToolRegistry` whose contents
 * are 100% derived from `live_agent_tool_bindings` rows.
 *
 * Design notes:
 *   - We reuse `createToolRegistry` rather than duplicating MCP / A2A wiring.
 *     The binder produces `catalogEntries` in the exact shape that factory
 *     already consumes (Phase 4 tool platform contract).
 *   - Built-in catalog entries surface their `tool_key` via the binder; we
 *     pass those as the `toolNames` argument so the corresponding entry in
 *     `BUILTIN_TOOLS` is registered.
 *   - Operator policy / credentials / audit emitter are layered on by the
 *     caller via `baseToolOptions` (typically `ChatEngine.toolOptions` or a
 *     similarly constructed bag). This bridge does NOT silently drop those
 *     concerns.
 */

import { resolveAgentToolCatalog } from '@weaveintel/live-agents-runtime';
import type { ToolRegistry } from '@weaveintel/core';

import type { DatabaseAdapter, ToolCatalogRow } from '../db-types.js';
import { createToolRegistry, type ToolRegistryOptions } from '../tools.js';

/** Result returned alongside the registry — useful for diagnostics. */
export interface BuildAgentToolRegistryResult {
  registry: ToolRegistry | undefined;
  catalogEntries: ToolCatalogRow[];
  builtinToolKeys: string[];
  warnings: Array<{ bindingId: string; message: string }>;
}

/**
 * Build a `ToolRegistry` populated solely from the agent's enabled tool
 * bindings. Returns `registry: undefined` when the agent has zero bindings,
 * matching geneweave's existing convention (no tools = no registry).
 */
export async function buildToolRegistryForAgent(
  db: DatabaseAdapter,
  agentId: string,
  baseToolOptions: ToolRegistryOptions = {},
): Promise<BuildAgentToolRegistryResult> {
  // The runtime-package binder reads bindings + resolves catalog rows.
  const resolved = await resolveAgentToolCatalog(db, agentId);

  // The binder's row type is structurally compatible with ToolCatalogRow,
  // but TS needs an explicit assertion through unknown for the cast.
  const catalogEntries = resolved.catalogEntries as unknown as ToolCatalogRow[];

  if (catalogEntries.length === 0 && resolved.builtinToolKeys.length === 0) {
    return {
      registry: undefined,
      catalogEntries: [],
      builtinToolKeys: [],
      warnings: resolved.warnings,
    };
  }

  const opts: ToolRegistryOptions = {
    ...baseToolOptions,
    // Per-agent catalog overrides any globally enabled set passed in.
    catalogEntries,
  };

  const registry = await createToolRegistry(
    resolved.builtinToolKeys,
    undefined,
    opts,
  );

  return {
    registry,
    catalogEntries,
    builtinToolKeys: resolved.builtinToolKeys,
    warnings: resolved.warnings,
  };
}
