/**
 * Conformance + unit tests — geneWeave's SQL adapters for Collaboration Phase 4
 * (run comments + annotations). Both run the SAME shared contracts the in-memory
 * reference adapters pass (one port, two interchangeable backends), then exercise
 * the public-share token util.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  commentManagerContract,
  annotationManagerContract,
  type CommentManager,
  type AnnotationManager,
} from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlCommentManager, createSqlAnnotationManager, mintPublicShareToken, hashPublicShareToken } from './run-comment-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-cmt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'owner', email: 'owner@x.dev', name: 'Owner', passwordHash: 'x' });
  return db;
}

// run_comments / run_annotations FK to user_runs, so wrap create to ensure the run.
async function makeCommentManager(): Promise<CommentManager> {
  const db = await freshDb();
  const mgr = createSqlCommentManager(db);
  return {
    ...mgr,
    create: async (input) => {
      await db.createUserRun({ id: input.runId, user_id: 'owner', status: 'completed', tenant_id: 'tA' }).catch(() => {});
      return mgr.create(input);
    },
  };
}
async function makeAnnotationManager(): Promise<AnnotationManager> {
  const db = await freshDb();
  const mgr = createSqlAnnotationManager(db);
  return {
    ...mgr,
    create: async (input) => {
      await db.createUserRun({ id: input.runId, user_id: 'owner', status: 'completed', tenant_id: 'tA' }).catch(() => {});
      return mgr.create(input);
    },
  };
}

commentManagerContract(makeCommentManager, { describe, it, beforeEach, expect } as never);
annotationManagerContract(makeAnnotationManager, { describe, it, beforeEach, expect } as never);

describe('mintPublicShareToken / hashPublicShareToken', () => {
  it('mints a long URL-safe token whose hash is deterministic and != the secret', () => {
    const a = mintPublicShareToken();
    expect(a.token.length).toBeGreaterThan(40);
    expect(/^[A-Za-z0-9_-]+$/.test(a.token)).toBe(true);
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'));
    expect(hashPublicShareToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toBe(a.token);
    expect(a.prefix).toBe(a.token.slice(0, 8));
    expect(mintPublicShareToken().token).not.toBe(a.token);
  });
});

describe('SQL comment adapter — persistence specifics', () => {
  it('persists the anchor (part id + seq + sub-range) and survives reload', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'completed', tenant_id: 'tA' });
    const mgr = createSqlCommentManager(db);
    const c = await mgr.create({
      id: 'c1', runId: 'r1', tenantId: 'tA', authorId: 'owner', body: 'check this `arg`',
      anchor: { partId: 'tool-3', createdAtSeq: 7, subRange: { startOffset: 0, endOffset: 4, quotedText: 'arg', prefix: 'the ', suffix: ' here' } },
    });
    expect(c.bodyHtml).toContain('<code>arg</code>');
    const reloaded = await createSqlCommentManager(db).getById('c1');
    expect(reloaded?.anchor.partId).toBe('tool-3');
    expect(reloaded?.anchor.createdAtSeq).toBe(7);
    expect(reloaded?.anchor.subRange?.quotedText).toBe('arg');
  });

  it('keeps annotations tenant/part scoped and exports averages', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'completed', tenant_id: 'tA' });
    const mgr = createSqlAnnotationManager(db);
    await mgr.create({ id: 'a1', runId: 'r1', tenantId: 'tA', authorId: 'owner', name: 'thumbs', dataType: 'boolean', value: 1, partId: 'tool-1' });
    await mgr.create({ id: 'a2', runId: 'r1', tenantId: 'tA', authorId: 'owner', name: 'thumbs', dataType: 'boolean', value: 0, partId: 'text-2' });
    expect((await mgr.listForRun('r1')).length).toBe(2);
    expect((await mgr.listForPart('r1', 'tool-1')).length).toBe(1);
    const a1 = await mgr.getById('a1');
    expect(a1?.value).toBe(1);
    expect(a1?.stringValue).toBe('true');
  });
});
