/**
 * Seed example workflows + a reusable subflow.
 *
 * Idempotent: each row is keyed by a stable id and only inserted when
 * absent. Demonstrates the four resolver kinds wired into the engine:
 *   - script:      inline JS expression
 *   - tool:        invoke a registered built-in tool
 *   - noop:        pass-through placeholder
 *   - subworkflow: start another workflow run and forward its result
 *
 * The seeded workflows are kept tiny and self-contained so they run
 * to completion in tests / examples / e2e without any LLM, network,
 * or external service.
 */

import type { DatabaseAdapter } from '../db-types.js';

interface SeedDef {
  id: string;
  name: string;
  description: string;
  steps: unknown[];
  entry_step_id: string;
}

const SEEDS: SeedDef[] = [
  {
    id: 'wf-greet-subflow',
    name: 'greet-subflow',
    description: 'Reusable subflow: returns "Hello, <name>!" using an inline script step.',
    entry_step_id: 'render',
    steps: [
      {
        id: 'render',
        name: 'Render greeting',
        type: 'deterministic',
        handler: 'script:return { greeting: "Hello, " + (variables.name ?? "world") + "!" };',
        outputMap: { 'variables.greeting': 'greeting' },
      },
    ],
  },
  {
    id: 'wf-greet-parent',
    name: 'greet-parent',
    description:
      'Parent workflow: invokes greet-subflow then echoes the result through a noop step.',
    entry_step_id: 'call-sub',
    steps: [
      {
        id: 'call-sub',
        name: 'Invoke subflow',
        type: 'sub-workflow',
        handler: 'subworkflow:wf-greet-subflow',
        inputMap: { name: 'name' },
        outputMap: { 'variables.subflowResult': '$' },
        next: 'echo',
      },
      {
        id: 'echo',
        name: 'Echo result',
        type: 'deterministic',
        handler: 'noop',
      },
    ],
  },
  {
    id: 'wf-tool-calc',
    name: 'tool-calc',
    description: 'Single-step workflow: invokes the calculator built-in tool.',
    entry_step_id: 'compute',
    steps: [
      {
        id: 'compute',
        name: 'Run calculator',
        type: 'deterministic',
        handler: 'tool:calculator',
        inputMap: { expression: 'expression' },
        outputMap: { 'variables.result': '$' },
      },
    ],
  },
];

export async function seedExampleWorkflows(db: DatabaseAdapter): Promise<void> {
  for (const def of SEEDS) {
    const existing = await db.getWorkflowDef(def.id).catch(() => null);
    if (existing) continue;
    await db.createWorkflowDef({
      id: def.id,
      name: def.name,
      description: def.description,
      version: '1.0.0',
      steps: JSON.stringify(def.steps),
      entry_step_id: def.entry_step_id,
      metadata: null,
      enabled: 1,
    });
  }
}
