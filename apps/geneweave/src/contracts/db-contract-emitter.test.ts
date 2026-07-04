/**
 * apps/geneweave — Phase 4 DbContractEmitter integration test.
 *
 * Verifies that emit() persists a row in mesh_contracts and notifies
 * the bus. Uses a real SQLite database via createDatabaseAdapter.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { createDatabaseAdapter } from '../db.js';
import { DbContractEmitter } from './db-contract-emitter.js';

function makeTempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gw-contract-'));
  return { dir, dbPath: join(dir, 'test.db') };
}

describe('DbContractEmitter', () => {
  it('persists a mesh_contracts row and emits on the bus', async () => {
    const { dir, dbPath } = makeTempDbPath();
    const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    try {
      const bus = new EventEmitter();
      const received: unknown[] = [];
      bus.on('contract_emitted', (ev) => received.push(ev));

      const emitter = new DbContractEmitter(db, bus);
      await emitter.emit({
        kind: 'demo.completed',
        body: { result: 'ok' },
        evidence: [{ stepId: 's1', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
        meta: {
          workflowDefinitionId: 'wf-1',
          workflowRunId: 'run-1',
          emittedAt: new Date().toISOString(),
          meshId: 'mesh-x',
          metadata: { tag: 'phase4' },
        },
      });

      const rows = await db.listMeshContracts({ kind: 'demo.completed', limit: 10, offset: 0 });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.kind).toBe('demo.completed');
      expect(row.mesh_id).toBe('mesh-x');
      expect(row.source_workflow_definition_id).toBe('wf-1');
      expect(row.source_workflow_run_id).toBe('run-1');
      const body = JSON.parse(row.body_json) as Record<string, unknown>;
      expect(body).toEqual({ result: 'ok' });
      const meta = JSON.parse(row.metadata!) as Record<string, unknown>;
      expect(meta).toEqual({ tag: 'phase4' });
      expect(row.evidence_json).not.toBeNull();

      // Bus notification fired.
      expect(received).toHaveLength(1);
      const ev = received[0] as { id: string; kind: string; body: unknown };
      expect(ev.kind).toBe('demo.completed');
      expect(ev.id).toBe(row.id);
      expect(ev.body).toEqual({ result: 'ok' });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles minimal emit (no evidence, no metadata, no meshId)', async () => {
    const { dir, dbPath } = makeTempDbPath();
    const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    try {
      const bus = new EventEmitter();
      const emitter = new DbContractEmitter(db, bus);
      await emitter.emit({
        kind: 'minimal.kind',
        body: {},
        meta: {
          workflowDefinitionId: 'wf-2',
          workflowRunId: 'run-2',
          emittedAt: new Date().toISOString(),
        },
      });
      const rows = await db.listMeshContracts({ limit: 10, offset: 0 });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.evidence_json).toBeNull();
      expect(row.metadata).toBeNull();
      expect(row.mesh_id).toBeNull();
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
