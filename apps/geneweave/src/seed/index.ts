/**
 * geneWeave seed orchestrator
 *
 * Single entry-point for all first-install seed data. Replaces the
 * inline `seedDefaultData()` calls and the six separate seed functions
 * previously called in `apps/geneweave/src/index.ts`.
 *
 * Usage:
 *   import { applySeed } from './seed/index.js';
 *   await applySeed(db);
 *
 * Order:
 *   1. seedDefaultData() — existing large method that seeds the bulk of config
 *      data (prompts, tools, agents, workflows, tenant configs, etc.)
 *   2. seedFramework()  — package seed arrays (guardrails, routing, skills …)
 *   3. seedAppSpecific() — geneWeave-specific data (kaggle, SV, live mesh …)
 *
 * seedFramework() is idempotent-by-design: each section checks existence
 * before inserting. seedAppSpecific() delegates to the existing idempotent
 * seed functions.
 *
 * Phase 4 completion: once seedDefaultData() sections are fully migrated into
 * seedFramework(), the first call below can be removed and seedDefaultData()
 * can be deleted from db-sqlite.ts.
 */

import type { DatabaseAdapter } from '../db-types.js';
import { seedFramework } from './framework.js';
import { seedAppSpecific } from './app-specific.js';
import { seedExampleWorkflows } from './workflows.js';

export async function applySeed(db: DatabaseAdapter): Promise<void> {
  // Phase 4: call the existing seedDefaultData() first to preserve the
  // bulk of prompt/tool/agent/workflow config, then layer the package seeds
  // on top. Once all sections are migrated into seedFramework(), remove this.
  if ('seedDefaultData' in db && typeof (db as { seedDefaultData(): Promise<void> }).seedDefaultData === 'function') {
    await (db as { seedDefaultData(): Promise<void> }).seedDefaultData();
  }

  await seedFramework(db);
  await seedAppSpecific(db);
  await seedExampleWorkflows(db);
}
