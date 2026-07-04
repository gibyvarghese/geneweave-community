/**
 * @weaveintel/geneweave — Admin CRUD routes
 *
 * Registers all admin configuration endpoints (prompts, guardrails, routing, etc.)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GuardrailRevisionStore, WeaveRuntime } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import { validateDetailedDescription } from './admin/api/admin-route-helpers.js';
import {
  registerAdminUserRoutes,
  registerAdminPromptRoutes,
  registerAdminRoutingRoutes,
  registerAdminConnectorRoutes,
  registerAdminCatalogRoutes,
  registerAdminA2ASkillRoutes,
} from './admin/routes/index.js';
import { registerScopeRoutes } from './admin/api/scope.js';
import { registerArtifactRoutes as registerAdminArtifactRoutes } from './admin/api/artifacts.js';
import { registerTenantArtifactSettingsRoutes } from './admin/api/tenant-artifact-settings.js';
import { registerTenantGovernanceRoutes } from './admin/api/tenant-governance.js';
import { registerTenantAppearanceRoutes } from './admin/api/tenant-appearance.js';
import { registerAiTransparencyRoutes } from './admin/api/ai-transparency.js';
import { registerI18nRoutes } from './admin/api/i18n.js';
import { registerSuggestedPromptsRoutes } from './admin/api/suggested-prompts.js';
import { registerChatCitationsRoutes } from './admin/api/chat-citations.js';
import { registerAnswerVersionsRoutes } from './admin/api/answer-versions.js';
import { registerAccessibilityRoutes } from './admin/api/accessibility.js';
import { registerWorkspaceRolesRoutes } from './admin/api/workspace-roles.js';
import type { RouterLike } from './admin/api/types.js';

export interface AdminRouteExtras {
  guardrailRevisionStore?: GuardrailRevisionStore;
  /** App-wide runtime — carries durable KV so weaveAudit writes persist. */
  runtime?: WeaveRuntime;
}

export function registerAdminRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  providers?: Record<string, { apiKey?: string }>,
  html?: (res: ServerResponse, status: number, body: string) => void,
  extras?: AdminRouteExtras,
): void {
  function requireDetailedDescription(
    description: unknown,
    kind: 'prompt' | 'tool' | 'skill' | 'agent',
    res: ServerResponse,
  ): string | null {
    const validation = validateDetailedDescription(description, kind);
    if (!validation.valid) {
      json(res, 400, { error: validation.error });
      return null;
    }
    return validation.description;
  }
  void requireDetailedDescription; // used by sub-modules via their own local copy

  registerAdminUserRoutes(router, db, json, readBody);
  registerAdminPromptRoutes(router, db, json, readBody);
  registerAdminRoutingRoutes(router, db, json, readBody, providers, extras?.guardrailRevisionStore, extras?.runtime);
  registerAdminConnectorRoutes(router, db, json, readBody, providers, html);
  registerAdminCatalogRoutes(router, db, json, readBody);
  registerAdminA2ASkillRoutes(router, db, json, readBody);
  // Scope isolation admin routes — requireDetailedDescription is not needed for scope tables
  registerScopeRoutes(router, db, {
    json,
    readBody,
    requireDetailedDescription: () => null,  // unused in scope routes
  });
  // m77: Artifact admin browser (read + download + delete)
  registerAdminArtifactRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m78: Tenant artifact type settings
  registerTenantArtifactSettingsRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m127: Per-tenant enterprise governance (weaveNotes Phase 2)
  registerTenantGovernanceRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  registerTenantAppearanceRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m137: Per-tenant AI transparency (label / disclosure / content warnings) + answer-feedback review
  registerAiTransparencyRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m138: Per-tenant answer-citations config (enabled / strictness / corpus scope)
  registerChatCitationsRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m139: Per-tenant regenerate/answer-versions config (enabled / how many versions to keep)
  registerAnswerVersionsRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m140: Per-tenant accessibility defaults (streaming announce mode + reduced motion)
  registerAccessibilityRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m143: Per-tenant workspace-role access policy (which optional areas members see)
  registerWorkspaceRolesRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m145: Per-tenant internationalisation policy (default language / enabled languages / assistant localisation)
  registerI18nRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
  // m146: Per-tenant suggested/starter prompts policy (enabled / personalisation sources / counts)
  registerSuggestedPromptsRoutes(router, db, { json, readBody, requireDetailedDescription: () => null });
}
