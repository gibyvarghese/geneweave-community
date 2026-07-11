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
  // Capture whether this is a fresh database BEFORE any seeding runs, so the lean
  // guardrail default below applies only on first install — never overriding an
  // admin's later enable/disable choices on subsequent boots.
  // A truly fresh install has no users yet (the first admin is created after boot).
  // Guardrail count is unreliable here because migrations seed guardrails before this runs.
  const freshDatabase = (await db.listUsers()).length === 0;

  // Phase 4: call the existing seedDefaultData() first to preserve the
  // bulk of prompt/tool/agent/workflow config, then layer the package seeds
  // on top. Once all sections are migrated into seedFramework(), remove this.
  if ('seedDefaultData' in db && typeof (db as { seedDefaultData(): Promise<void> }).seedDefaultData === 'function') {
    await (db as { seedDefaultData(): Promise<void> }).seedDefaultData();
  }

  await seedFramework(db);
  await seedAppSpecific(db);
  await seedExampleWorkflows(db);

  // ── Community lean guardrail default ──────────────────────────────────────────
  // The framework ships a large guardrail set; roughly half are LLM-judge based
  // (model-graded reasoning judges, factuality/hallucination checks, cognitive
  // checks). Those add latency + cost per turn and, on a weak judge model, can
  // misfire and block correct answers. Make them OPT-IN so a fresh install is fast
  // and predictable — deterministic safety (PII redaction, prompt-injection,
  // credential/SSRF filters, moderation, token budget) stays on. Enable the LLM
  // judges from the admin Guardrails page, or set GENEWEAVE_ENABLE_LLM_JUDGES=1.
  // Fresh DB only, so it never clobbers an operator's later choices.
  if (freshDatabase && process.env['GENEWEAVE_ENABLE_LLM_JUDGES'] !== '1') {
    const HEAVY = new Set(['model-graded', 'factuality', 'cognitive_check']);
    for (const g of await db.listGuardrails()) {
      if (HEAVY.has(g.type) && g.enabled) await db.updateGuardrail(g.id, { enabled: 0 });
    }
  }

  // ── Registry-wide realm seed reconcile (Upgrade Engine, L4) ───────────────────
  // Runs LAST, after every seed section has inserted its rows, so the reconcile sees the final shipped
  // state. For each realm family it publishes this release's defaults into realm_versions and — the key
  // upgrade behaviour — adopts a changed default the operator never touched (stale), keeps a customized or
  // diverged one, and records every outcome to upgrade_details under a persisted upgrade run. Content-
  // addressed, so on an unchanged re-boot it is a cheap no-op. Called defensively (like seedDefaultData)
  // so an adapter that does not implement it simply skips this step.
  if ('seedReconcileRealm' in db && typeof (db as { seedReconcileRealm?: unknown }).seedReconcileRealm === 'function') {
    await (db as { seedReconcileRealm(): Promise<{ runId: string }> }).seedReconcileRealm();
  }
}
