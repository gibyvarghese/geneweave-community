/**
 * Phase K5 — Demo Kaggle live-agents mesh seed.
 *
 * On first boot (when the geneweave pointer index is empty), provisions a
 * single demo mesh into the live-agents StateStore so operators have data
 * to browse in the admin UI. Skipped on subsequent boots.
 *
 * Production deployments set KAGGLE_DEMO_SEED=false to disable.
 *
 * Phase D — switched from the bespoke `bootKaggleMesh` to the generic
 * `provisionMesh` so the demo mesh is provisioned from the same DB
 * blueprint (`live_mesh_definitions` key 'kaggle') used by per-run
 * provisioning in `runner.ts` and the admin provisioning route.
 */

import { provisionMesh } from '@weaveintel/live-agents-runtime';
import type { DatabaseAdapter } from '../../db-types.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getKaggleLiveStore } from './store.js';

const DEMO_TENANT = 'demo-tenant';
const DEMO_USER = 'demo-user';
const DEMO_HUMAN = 'human:demo-owner';
const DEMO_MCP_URL = 'http://localhost:8788/mcp';

export async function seedKaggleDemoMesh(db: DatabaseAdapter): Promise<void> {
  if (process.env['KAGGLE_DEMO_SEED'] === 'false') return;

  const existing = await db.listKaggleLiveMeshes();
  if (existing.length > 0) return;

  try {
    const store = await getKaggleLiveStore();
    const result = await provisionMesh(
      db,
      {
        meshDefKey: 'kaggle',
        tenantId: DEMO_TENANT,
        ownerHumanId: DEMO_HUMAN,
        name: `mesh-kaggle-demo-${newUUIDv7()}`,
        status: 'ACTIVE',
        store,
        account: {
          provider: 'kaggle.com',
          accountIdentifier: DEMO_USER,
          mcpServerUrl: DEMO_MCP_URL,
          credentialVaultRef: 'env:KAGGLE_KEY',
          upstreamScopesDescription:
            'Kaggle REST API: list competitions/datasets/kernels, push kernels, submit to competitions.',
          description: `Demo Kaggle credentials for ${DEMO_USER}`,
        },
        logger: (msg) => console.log('[kaggle-seed]', msg),
      },
      newUUIDv7,
    );
    await db.upsertKaggleLiveMesh({
      mesh_id: result.meshId,
      tenant_id: DEMO_TENANT,
      kaggle_username: DEMO_USER,
    });
    // eslint-disable-next-line no-console
    console.log(`[kaggle-seed] provisioned demo mesh ${result.meshId}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[kaggle-seed] demo mesh seed skipped:', (err as Error).message);
  }
}
