/**
 * Phase 3 — artifacts are run-scoped (run_id) when produced via /api/me/runs.
 *
 * The emit_artifact tool now threads `currentRunId` into `artifactSave`, and the
 * persistence layer writes `artifacts.run_id`. Positive, negative, security.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-phase3-art-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('Phase 3 — artifact run_id persistence', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
  });
  afterEach(async () => { await db.close(); });

  it('persists run_id when supplied (positive)', async () => {
    const saved = await db.saveArtifact({ name: 'chart', type: 'html', mimeType: 'text/html', data: '<b>hi</b>', sessionId: 'c1', userId: 'u1', runId: 'run-123', scope: 'session' });
    const row = await db.getArtifact(saved.id);
    expect(row).toBeTruthy();
    expect(row!.run_id).toBe('run-123');
  });

  it('leaves run_id NULL when not supplied (negative — web/chat path)', async () => {
    const saved = await db.saveArtifact({ name: 'doc', type: 'markdown', mimeType: 'text/markdown', data: '# x', sessionId: 'c1', userId: 'u1', scope: 'session' });
    const row = await db.getArtifact(saved.id);
    expect(row!.run_id).toBeNull();
  });

  it('keeps run_id isolated per artifact (security: no cross-run bleed)', async () => {
    const a = await db.saveArtifact({ name: 'a', type: 'text', mimeType: 'text/plain', data: 'a', userId: 'u1', runId: 'run-A', scope: 'session' });
    const b = await db.saveArtifact({ name: 'b', type: 'text', mimeType: 'text/plain', data: 'b', userId: 'u1', runId: 'run-B', scope: 'session' });
    expect((await db.getArtifact(a.id))!.run_id).toBe('run-A');
    expect((await db.getArtifact(b.id))!.run_id).toBe('run-B');
  });
});
