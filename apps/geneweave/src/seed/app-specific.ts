/**
 * geneWeave-specific seed — data that belongs to this app, not to any package.
 *
 * Includes: Kaggle live mesh, Kaggle arc playbook, hypothesis validation (SV)
 * supervisor agents, live handler kinds + attention policies, and any other
 * geneWeave-specific configuration rows.
 *
 * These functions already contain idempotency guards and are called unchanged
 * from the new applySeed() orchestrator.
 */

import { seedSVData } from '../features/scientific-validation/sv-seed.js';
import { seedKaggleDemoMesh } from '../live-agents/kaggle/seed.js';
import { seedKaggleArcPlaybook } from '../live-agents/kaggle/playbook-seed.js';
import { seedLiveMeshDefinitions } from '../live-agents/live-mesh-defs-seed.js';
import {
  seedLiveHandlerKinds,
  seedLiveAttentionPolicies,
} from '../live-agents/live-handler-kinds-seed.js';
import type { DatabaseAdapter } from '../db-types.js';

export async function seedAppSpecific(db: DatabaseAdapter): Promise<void> {
  // Handler kinds and attention policies are written via the package seed in
  // framework.ts. The existing app-side seedLiveHandlerKinds / seedLiveAttentionPolicies
  // add extended metadata (tool_catalog_keys, etc.) — run them after framework seed
  // so their backfill logic can patch any rows that framework.ts just inserted.
  await seedLiveHandlerKinds(db);
  await seedLiveAttentionPolicies(db);

  // Kaggle live mesh and playbook (geneWeave-specific)
  await seedLiveMeshDefinitions(db);
  await seedKaggleDemoMesh(db);
  await seedKaggleArcPlaybook(db);

  // Hypothesis validation / scientific validation supervisor agents
  await seedSVData(db);
}
