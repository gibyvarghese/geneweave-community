/**
 * Geneweave glue for the DB-driven handler-kind registry.
 *
 * Phase 2 of the live-agents runtime plan: app boot creates a single
 * `HandlerRegistry` populated with the built-in plugins from
 * `@weaveintel/live-agents-runtime`, and immediately syncs each registered
 * kind into the `live_handler_kinds` DB table so the admin UI reflects the
 * code reality.
 *
 * The registry singleton is exposed via `getHandlerRegistry()` so future
 * phases (heartbeat supervisor, MeshProvisioner) can resolve a `TaskHandler`
 * for any `live_agent_handler_bindings` row without taking a parameter.
 *
 * Sync behaviour:
 *   - First boot — inserts a `source='builtin'` row per registered kind.
 *   - Subsequent boots — UPDATEs description + config_schema_json on
 *     existing rows so plugin changes propagate, but never flips operator
 *     toggles (e.g. `enabled`).
 *   - DB rows for kinds NOT registered in code are left untouched (those
 *     are reserved seeds for upcoming phases).
 */

import {
  HandlerRegistry,
  createDefaultHandlerRegistry,
  type HandlerKindRegistration,
} from '@weaveintel/live-agents-runtime';
import {
  geneweaveComputerUseHandler,
  geneweaveBrowserHandler,
  geneweaveCodeInterpreterHandler,
} from './handlers/index.js';
import type { DatabaseAdapter } from '../db.js';
import { newUUIDv7 } from '../lib/uuid.js';

let _registry: HandlerRegistry | null = null;

/** Initialise (or reset) the process-wide handler registry. Idempotent. */
export function initHandlerRegistry(): HandlerRegistry {
  if (!_registry) {
    _registry = createDefaultHandlerRegistry();
    // Override the three handler kinds that need geneweave-specific wiring:
    //   • agentic.computer-use     — CUA model wrapping + auto-inject CUA tools
    //   • agentic.browser          — domain allowlist guard + headless validation
    //   • agentic.code-interpreter — CSE sandbox validation + runtime banner
    _registry.registerOrReplace(geneweaveComputerUseHandler);
    _registry.registerOrReplace(geneweaveBrowserHandler);
    _registry.registerOrReplace(geneweaveCodeInterpreterHandler);
  }
  return _registry;
}

/** Read the current registry. Throws if not yet initialised. */
export function getHandlerRegistry(): HandlerRegistry {
  if (!_registry) {
    throw new Error('Handler registry not initialised; call initHandlerRegistry() at boot.');
  }
  return _registry;
}

/**
 * Sync registered handler kinds → DB so admin operators see the code reality.
 *
 * - INSERT a row when none exists (id = UUIDv7, source='builtin', enabled=1).
 * - UPDATE description + config_schema_json on existing rows. We deliberately
 *   skip toggling `enabled` so operators can disable a kind without it
 *   flipping back on every restart.
 */
export async function syncHandlerKindsToDb(
  db: DatabaseAdapter,
  registry: HandlerRegistry,
): Promise<void> {
  for (const reg of registry.list()) {
    const schemaJson = JSON.stringify(reg.configSchema ?? { type: 'object', properties: {} });
    const existing = await db.getLiveHandlerKindByKind(reg.kind);
    if (!existing) {
      await db.createLiveHandlerKind({
        id: newUUIDv7(),
        kind: reg.kind,
        description: reg.description,
        config_schema_json: schemaJson,
        source: 'builtin',
        enabled: 1,
      });
      continue;
    }
    // Refresh description/schema only — never overwrite operator state.
    if (existing.description !== reg.description || existing.config_schema_json !== schemaJson) {
      await db.updateLiveHandlerKind(existing.id, {
        description: reg.description,
        config_schema_json: schemaJson,
      });
    }
  }
}

/** Helper for tests / examples that want to enumerate registered kinds. */
export function listRegisteredHandlerKinds(): HandlerKindRegistration[] {
  return getHandlerRegistry().list();
}
