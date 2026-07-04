import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  createGeneweaveWorkflowEngine,
  syncWorkflowHandlerKindsToDb,
} from './workflow-engine.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-workflow-engine-test-${Date.now()}-${randomUUID()}.db`;
}

// Stub tool with the weaveTool() shape: { schema, invoke(ctx, { arguments }) }
const stubUpper = {
  schema: { name: 'upper', description: 'uppercase', parameters: { type: 'object' } },
  async invoke(_ctx: Record<string, unknown>, input: { arguments: Record<string, unknown> }) {
    const text = String(input.arguments['text'] ?? '');
    return { upper: text.toUpperCase() };
  },
};

const stubExecute = {
  async execute(input: Record<string, unknown>) {
    return { doubled: Number(input['n'] ?? 0) * 2 };
  },
};

describe('geneweave workflow-engine integration', () => {
  // The `script:` resolver is gated behind an explicit operator opt-in
  // (arbitrary in-process code execution). This suite exercises a
  // tool→script→noop pipeline, so enable the opt-in for the file.
  const prevScriptFlag = process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'];
  beforeAll(() => {
    process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'] = '1';
  });
  afterAll(() => {
    if (prevScriptFlag === undefined) delete process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'];
    else process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'] = prevScriptFlag;
  });

  it('syncs handler kinds into workflow_handler_kinds and runs a tool→script→noop pipeline E2E', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    const handle = createGeneweaveWorkflowEngine({
      db,
      toolGetter: (key: string) => {
        if (key === 'upper') return stubUpper;
        if (key === 'doubler') return stubExecute;
        return undefined;
      },
    });

    // 1. Sync handler kinds catalog.
    await syncWorkflowHandlerKindsToDb(db, handle.registry);
    const kinds = await db.listWorkflowHandlerKinds();
    const kindNames = kinds.map((k) => k.kind).sort();
    expect(kindNames).toContain('noop');
    expect(kindNames).toContain('script');
    expect(kindNames).toContain('tool');
    for (const k of kinds) {
      expect(k.source).toBe('builtin');
      expect(k.enabled).toBe(1);
    }

    // 2. Persist a definition via the in-memory + DB-backed store.
    await handle.store.save({
      id: 'wf-test-1',
      name: 'Test pipeline',
      version: '1.0',
      entryStepId: 'upper',
      steps: [
        {
          id: 'upper',
          name: 'Upper',
          type: 'deterministic',
          handler: 'tool:upper',
          inputMap: { text: 'message' },
          outputMap: { capitalized: 'upper' },
          next: 'count',
        },
        {
          id: 'count',
          name: 'Count',
          type: 'deterministic',
          handler: 'script:',
          config: { script: 'return variables.capitalized.length;' },
          outputMap: { length: '$' },
          next: 'done',
        },
        { id: 'done', name: 'Done', type: 'deterministic', handler: 'noop' },
      ],
    });

    // 3. Confirm DB persistence.
    const row = await db.getWorkflowDef('wf-test-1');
    expect(row).toBeTruthy();
    expect(row!.entry_step_id).toBe('upper');

    // 4. Run E2E.
    const run = await handle.engine.startRun('wf-test-1', { message: 'hello' });
    expect(run.status).toBe('completed');
    expect(run.state.variables['capitalized']).toBe('HELLO');
    expect(run.state.variables['length']).toBe(5);
  });

  it('returns undefined from tool resolver for unknown keys (graceful failure)', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    const handle = createGeneweaveWorkflowEngine({
      db,
      toolGetter: () => undefined,
    });

    await handle.store.save({
      id: 'wf-missing',
      name: 'Missing tool',
      version: '1.0',
      entryStepId: 's1',
      steps: [{ id: 's1', name: 'S1', type: 'deterministic', handler: 'tool:does_not_exist' }],
    });

    const run = await handle.engine.startRun('wf-missing', {});
    expect(run.status).toBe('failed');
    expect(String(run.error)).toContain('no tool registered');
  });

  it('supports tools that expose .execute() in addition to .invoke()', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    const handle = createGeneweaveWorkflowEngine({
      db,
      toolGetter: (key: string) => (key === 'doubler' ? stubExecute : undefined),
    });

    await handle.store.save({
      id: 'wf-exec',
      name: 'Execute shape',
      version: '1.0',
      entryStepId: 's1',
      steps: [
        {
          id: 's1',
          name: 'S1',
          type: 'deterministic',
          handler: 'tool:doubler',
          inputMap: { n: 'x' },
          outputMap: { y: 'doubled' },
        },
      ],
    });

    const run = await handle.engine.startRun('wf-exec', { x: 21 });
    expect(run.status).toBe('completed');
    expect(run.state.variables['y']).toBe(42);
  });
});
