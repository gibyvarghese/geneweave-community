/**
 * Phase 5 — Admin route: provision a runtime mesh from a DB blueprint.
 *
 * `POST /api/admin/live-meshes/provision`
 *
 * Body shape:
 *   {
 *     "mesh_def_id"?:   string,         // OR mesh_def_key — exactly one
 *     "mesh_def_key"?:  string,
 *     "tenant_id":      string | null,
 *     "owner_human_id": string,
 *     "name"?:          string,         // defaults to def.name
 *     "status"?:        "ACTIVE" | "PAUSED",  // default ACTIVE
 *     "account"?: {
 *       "provider":                 string,
 *       "account_identifier":       string,
 *       "mcp_server_url":           string,
 *       "credential_vault_ref":     string,
 *       "upstream_scopes_description"?: string,
 *       "description"?:             string
 *     }
 *   }
 *
 * Returns 201 with `{ provisioned: { meshId, agentIds, … } }` and
 * additionally writes the runtime topology into the live-agents StateStore
 * so the generic supervisor (when enabled) can immediately tick the new
 * mesh without a process restart.
 *
 * Auth + CSRF guarded. Uses the shared `provisionMesh()` from
 * `@weaveintel/live-agents-runtime` — no duplicated logic.
 */

import { provisionMesh } from '@weaveintel/live-agents-runtime';
import type { DatabaseAdapter } from '../../db.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getGenericLiveStore } from '../../live-agents/generic-store.js';
import type { RouterLike, AdminHelpers } from './types.js';

const PROVISION_PATH = '/api/admin/live-meshes/provision';

export function registerLiveMeshProvisionerRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.post(
    PROVISION_PATH,
    async (req, res, _params, auth) => {
      if (!auth) {
        json(res, 401, { error: 'Not authenticated' });
        return;
      }
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const meshDefId = typeof body['mesh_def_id'] === 'string' ? body['mesh_def_id'] : undefined;
      const meshDefKey = typeof body['mesh_def_key'] === 'string' ? body['mesh_def_key'] : undefined;
      if (!meshDefId && !meshDefKey) {
        json(res, 400, { error: 'mesh_def_id or mesh_def_key required' });
        return;
      }
      if (typeof body['owner_human_id'] !== 'string' || !body['owner_human_id']) {
        json(res, 400, { error: 'owner_human_id required' });
        return;
      }

      // Optional account spec: when present, an Account + per-agent
      // AccountBindings are mirrored into the StateStore.
      let accountSpec: Parameters<typeof provisionMesh>[1]['account'];
      if (body['account'] && typeof body['account'] === 'object') {
        const a = body['account'] as Record<string, unknown>;
        if (
          typeof a['provider'] === 'string' &&
          typeof a['account_identifier'] === 'string' &&
          typeof a['mcp_server_url'] === 'string' &&
          typeof a['credential_vault_ref'] === 'string'
        ) {
          accountSpec = {
            provider: a['provider'],
            accountIdentifier: a['account_identifier'],
            mcpServerUrl: a['mcp_server_url'],
            credentialVaultRef: a['credential_vault_ref'],
            ...(typeof a['upstream_scopes_description'] === 'string'
              ? { upstreamScopesDescription: a['upstream_scopes_description'] }
              : {}),
            ...(typeof a['description'] === 'string' ? { description: a['description'] } : {}),
          };
        } else {
          json(res, 400, {
            error:
              'account requires provider, account_identifier, mcp_server_url, credential_vault_ref',
          });
          return;
        }
      }

      const store = await getGenericLiveStore();
      try {
        const result = await provisionMesh(
          db,
          {
            ...(meshDefId ? { meshDefId } : {}),
            ...(meshDefKey ? { meshDefKey } : {}),
            tenantId:
              body['tenant_id'] === null || body['tenant_id'] === undefined
                ? null
                : String(body['tenant_id']),
            ownerHumanId: String(body['owner_human_id']),
            ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
            ...(body['status'] === 'PAUSED' || body['status'] === 'ACTIVE'
              ? { status: body['status'] as 'ACTIVE' | 'PAUSED' }
              : {}),
            ...(accountSpec ? { account: accountSpec } : {}),
            store,
          },
          newUUIDv7,
        );
        json(res, 201, { provisioned: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: msg });
      }
    },
    { auth: true, csrf: true },
  );
}
