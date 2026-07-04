/**
 * /api/me/catalog source + resolver wiring (W9b Gap 2)
 *
 * Replaces the ad-hoc mode-only catalog assembly with the shared
 * `@weaveintel/identity` surface-catalog resolver. The resolver fans out to
 * DB-backed CatalogSources in parallel, runs each entry through a fail-closed
 * RBAC access check, caches per (tenant, principal, surface), and emits the
 * `catalog.resolved` observability span.
 *
 * Sources (all DB-driven, all fail-soft → return [] on any error):
 *   - modes   → mode_labels rows for the surface
 *   - agents  → ACTIVE live-agents
 *   - models  → enabled model_pricing rows
 *   - skills  → enabled skills
 *
 * Access check: entries whose kind maps to a required permission are excluded
 * for principals lacking it (e.g. `agent` requires `agents:read`, which
 * tenant_user does not hold). Modes/models/skills are visible to every signed-in
 * principal. Throwing in the check counts as deny (fail-closed).
 */

import type { ExecutionContext, CatalogEntry, SurfaceCatalogResolver } from '@weaveintel/core';
import { createSurfaceCatalogResolver } from '@weaveintel/identity';
import type { CatalogSource, AccessCheck } from '@weaveintel/identity';
import { canPersonaAccess } from './rbac.js';
import type { DatabaseAdapter } from './db-types.js';

/** Permission a principal must hold to see entries of a given kind. */
const KIND_PERMISSION: Partial<Record<CatalogEntry['kind'], string>> = {
  agent: 'agents:read',
};

/** Read the caller persona stamped onto the execution context metadata. */
function personaOf(ctx: ExecutionContext): string | null {
  const p = ctx.metadata?.['persona'];
  return typeof p === 'string' ? p : null;
}

/** Default RBAC-backed access check — fail-closed. */
export function defaultCatalogAccessCheck(ctx: ExecutionContext, entry: CatalogEntry): boolean {
  const required = KIND_PERMISSION[entry.kind];
  if (!required) return true;
  return canPersonaAccess(personaOf(ctx), required);
}

/** Build the DB-driven catalog sources. Each source never throws. */
export function createMeCatalogSources(db: DatabaseAdapter): CatalogSource[] {
  return [
    {
      name: 'mode-labels',
      async entries(_ctx, req): Promise<CatalogEntry[]> {
        try {
          const modes = await db.listModeLabels(req.surfaceId);
          return modes.map((m) => ({
            id: m.id,
            kind: 'mode' as const,
            label: m.label,
            ...(m.description ? { description: m.description } : {}),
            ...(m.is_default ? { default: true } : {}),
            ...(m.metadata ? { metadata: safeJson(m.metadata) } : {}),
          }));
        } catch { return []; }
      },
    },
    {
      name: 'live-agents',
      async entries(): Promise<CatalogEntry[]> {
        try {
          const agents = await db.listLiveAgents({ status: 'ACTIVE' });
          return agents.map((a) => ({
            id: a.id,
            kind: 'agent' as const,
            label: a.name,
            ...(a.role_label ? { description: a.role_label } : {}),
            metadata: { roleKey: a.role_key, meshId: a.mesh_id },
          }));
        } catch { return []; }
      },
    },
    {
      name: 'models',
      async entries(): Promise<CatalogEntry[]> {
        try {
          const models = await db.listModelPricing();
          return models
            .filter((m) => m.enabled === 1)
            .map((m) => ({
              id: m.model_id,
              kind: 'model' as const,
              label: m.display_name ?? m.model_id,
              metadata: { provider: m.provider },
            }));
        } catch { return []; }
      },
    },
    {
      name: 'skills',
      async entries(): Promise<CatalogEntry[]> {
        try {
          const skills = await db.listSkills();
          return skills
            .filter((s) => s.enabled === 1)
            .map((s) => ({
              id: s.id,
              kind: 'skill' as const,
              label: s.name,
              ...(s.description ? { description: s.description } : {}),
            }));
        } catch { return []; }
      },
    },
  ];
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * Construct the surface-catalog resolver for /api/me/catalog. Built once per
 * server (caching is keyed by tenant + principal + surface, so personas never
 * bleed across principals).
 */
export function createMeCatalogResolver(
  db: DatabaseAdapter,
  opts: { sources?: CatalogSource[]; accessCheck?: AccessCheck; cacheTtlMs?: number } = {},
): SurfaceCatalogResolver {
  return createSurfaceCatalogResolver({
    sources: opts.sources ?? createMeCatalogSources(db),
    accessCheck: opts.accessCheck ?? defaultCatalogAccessCheck,
    ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}),
  });
}
