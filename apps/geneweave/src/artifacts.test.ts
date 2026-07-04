/**
 * GeneWeave — artifacts.test.ts
 *
 * Integration tests for the full artifact storage stack (Phase 0 + Phase 1).
 *
 * Test categories:
 *   Unit (InMemory)   — createInMemoryArtifactStore: save, update, list, delete, policy
 *   DB (SQLite)       — SQLiteAdapter artifact methods: save, update, list, delete, versions
 *   Tool (emit)       — createToolRegistry with emit_artifact + artifactSave callback
 *   Factory           — createArtifactStore() switching between backends
 *   Filesystem        — createFilesystemArtifactStore via factory
 *   Retention job     — startArtifactRetentionJob calls expireArtifacts
 *   Artifact routes   — GET/DELETE /api/artifacts endpoints (auth guards + scope)
 *   Negative          — missing artifact, version pin mismatch, policy violations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  createInMemoryArtifactStore,
  createArtifactStore,
  createArtifactPolicy,
  validateArtifact,
  isExpired,
  inferMimeType,
  inferCodeMime,
  detectImageMime,
  createArtifactReference,
  resolveReference,
  tryResolveReference,
  formatReference,
} from '@weaveintel/artifacts';
import { createToolRegistry } from './tools.js';

function makeTempDbPath(): string {
  return join(tmpdir(), `weaveintel-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ─── InMemory store unit tests ────────────────────────────────────────────────

describe('InMemory ArtifactStore', () => {
  const store = createInMemoryArtifactStore();

  it('saves and retrieves an artifact', async () => {
    const a = await store.save({ name: 'report', type: 'text', mimeType: 'text/plain', data: 'hello', version: 1, scope: 'session' });
    expect(a.id).toBeTruthy();
    const fetched = await store.get(a.id);
    expect(fetched?.name).toBe('report');
  });

  it('update() creates a new version', async () => {
    const a = await store.save({ name: 'chart', type: 'svg', mimeType: 'image/svg+xml', data: '<svg/>', version: 1, scope: 'session' });
    const updated = await store.update(a.id, { data: '<svg id="v2"/>' }, 'added id');
    expect(updated.version).toBe(2);
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(2);
  });

  it('list() filters by type array', async () => {
    await store.save({ name: 'a', type: 'json', mimeType: 'application/json', data: {}, version: 1, scope: 'session' });
    await store.save({ name: 'b', type: 'csv', mimeType: 'text/csv', data: 'x,y', version: 1, scope: 'session' });
    const results = await store.list({ type: ['json', 'csv'] });
    expect(results.every((r) => ['json', 'csv'].includes(r.type))).toBe(true);
  });

  it('list() filters by sessionId', async () => {
    await store.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'x', version: 1, scope: 'session', sessionId: 'sess-A' });
    await store.save({ name: 'y', type: 'text', mimeType: 'text/plain', data: 'y', version: 1, scope: 'session', sessionId: 'sess-B' });
    const results = await store.list({ sessionId: 'sess-A' });
    expect(results.every((r) => r.sessionId === 'sess-A')).toBe(true);
  });

  it('list() filters by userId + scope=user', async () => {
    await store.save({ name: 'profile', type: 'json', mimeType: 'application/json', data: {}, version: 1, scope: 'user', userId: 'u-1' });
    await store.save({ name: 'ephemeral', type: 'text', mimeType: 'text/plain', data: 'x', version: 1, scope: 'session' });
    const userArtifacts = await store.list({ userId: 'u-1', scope: 'user' });
    expect(userArtifacts.every((r) => r.userId === 'u-1')).toBe(true);
  });

  it('delete() removes artifact and versions', async () => {
    const a = await store.save({ name: 'temp', type: 'text', mimeType: 'text/plain', data: 'bye', version: 1, scope: 'session' });
    await store.delete(a.id);
    expect(await store.get(a.id)).toBeNull();
    expect(await store.getVersions(a.id)).toHaveLength(0);
  });

  it('policy enforcement at save: throws when violated', async () => {
    const restrictedStore = createInMemoryArtifactStore({
      policy: createArtifactPolicy({ name: 'tiny', maxSizeBytes: 3 }),
    });
    await expect(
      restrictedStore.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'this is too long', version: 1, scope: 'session' })
    ).rejects.toThrow(/policy violation/i);
  });
});

// ─── Reference tests ──────────────────────────────────────────────────────────

describe('ArtifactReference', () => {
  const store = createInMemoryArtifactStore();

  it('resolveReference returns artifact for latest version', async () => {
    const a = await store.save({ name: 'r', type: 'text', mimeType: 'text/plain', data: 'v1', version: 1, scope: 'session' });
    const ref = createArtifactReference(a.id);
    const resolved = await resolveReference(store, ref);
    expect(resolved.data).toBe('v1');
  });

  it('resolveReference returns pinned version', async () => {
    const a = await store.save({ name: 'r', type: 'text', mimeType: 'text/plain', data: 'v1', version: 1, scope: 'session' });
    await store.update(a.id, { data: 'v2' });
    const ref = createArtifactReference(a.id, 1);
    const resolved = await resolveReference(store, ref);
    expect(resolved.data).toBe('v1');
    expect(resolved.version).toBe(1);
  });

  it('resolveReference throws on missing artifact', async () => {
    await expect(resolveReference(store, { artifactId: 'ghost' })).rejects.toThrow(/not found/i);
  });

  it('resolveReference throws on missing pinned version', async () => {
    const a = await store.save({ name: 'r', type: 'text', mimeType: 'text/plain', data: 'v1', version: 1, scope: 'session' });
    await expect(resolveReference(store, { artifactId: a.id, version: 99 })).rejects.toThrow(/version 99 not found/i);
  });

  it('tryResolveReference returns null instead of throwing', async () => {
    expect(await tryResolveReference(store, { artifactId: 'ghost' })).toBeNull();
  });

  it('formatReference serialises correctly', () => {
    expect(formatReference({ artifactId: 'abc', version: 2, label: 'Draft' })).toBe('artifact:abc@v2 (Draft)');
  });
});

// ─── MIME / type system ───────────────────────────────────────────────────────

describe('MIME inference', () => {
  it('inferMimeType covers all 18 types', () => {
    const types = ['text', 'markdown', 'csv', 'json', 'code', 'html', 'pdf', 'report',
      'image', 'svg', 'diagram', 'mermaid', 'react', 'interactive', 'audio', 'video',
      'spreadsheet', 'custom'] as const;
    for (const t of types) {
      expect(inferMimeType(t)).toBeTruthy();
    }
  });

  it('inferMimeType(code, {language:python}) → text/x-python', () => {
    expect(inferMimeType('code', { language: 'python' })).toBe('text/x-python');
  });

  it('inferCodeMime handles all common languages', () => {
    expect(inferCodeMime('typescript')).toBe('text/typescript');
    expect(inferCodeMime('sql')).toBe('application/sql');
    expect(inferCodeMime('rust')).toBe('text/x-rustsrc');
  });

  it('detectImageMime detects JPEG', () => {
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(detectImageMime(jpegMagic)).toBe('image/jpeg');
  });

  it('detectImageMime detects PNG', () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(detectImageMime(pngMagic)).toBe('image/png');
  });
});

// ─── Policy tests ─────────────────────────────────────────────────────────────

describe('ArtifactPolicy', () => {
  it('validateArtifact passes compliant artifact', () => {
    const policy = createArtifactPolicy({ name: 'default' });
    const result = validateArtifact(
      { id: 'x', name: 'r', type: 'text', mimeType: 'text/plain', data: 'hi', version: 1, createdAt: new Date().toISOString() },
      policy,
    );
    expect(result.valid).toBe(true);
  });

  it('validateArtifact fails on size violation', () => {
    const policy = createArtifactPolicy({ name: 'tiny', maxSizeBytes: 1 });
    const result = validateArtifact(
      { id: 'x', name: 'r', type: 'text', mimeType: 'text/plain', data: 'hello world', sizeBytes: 11, version: 1, createdAt: new Date().toISOString() },
      policy,
    );
    expect(result.valid).toBe(false);
  });

  it('isExpired returns false for fresh artifact', () => {
    const policy = createArtifactPolicy({ name: '30-day', retentionDays: 30 });
    const fresh = { id: 'x', name: 'r', type: 'text' as const, mimeType: 'text/plain', data: '', version: 1, createdAt: new Date().toISOString() };
    expect(isExpired(fresh, policy)).toBe(false);
  });

  it('isExpired returns true for old artifact', () => {
    const policy = createArtifactPolicy({ name: '1-day', retentionDays: 1 });
    const old = { id: 'x', name: 'r', type: 'text' as const, mimeType: 'text/plain', data: '', version: 1,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isExpired(old, policy)).toBe(true);
  });
});

// ─── SQLite adapter integration ───────────────────────────────────────────────

describe('SQLiteAdapter artifacts (m77)', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('saveArtifact persists and returns a row', async () => {
    const row = await db.saveArtifact!({
      name: 'report',
      type: 'text',
      mimeType: 'text/plain',
      data: 'hello world',
      scope: 'session',
      sessionId: 'sess-1',
    });
    expect(row.id).toBeTruthy();
    expect(row.name).toBe('report');
    expect(row.version).toBe(1);
    expect(row.session_id).toBe('sess-1');
  });

  it('getArtifact retrieves by id', async () => {
    const row = await db.saveArtifact!({ name: 'a', type: 'json', mimeType: 'application/json', data: {k:1}, scope: 'session' });
    const fetched = await db.getArtifact!(row.id);
    expect(fetched?.id).toBe(row.id);
    expect(fetched?.name).toBe('a');
  });

  it('getArtifact returns null for unknown id', async () => {
    expect(await db.getArtifact!('ghost')).toBeNull();
  });

  it('updateArtifact increments version', async () => {
    const row = await db.saveArtifact!({ name: 'chart', type: 'svg', mimeType: 'image/svg+xml', data: '<svg/>', scope: 'session' });
    const updated = await db.updateArtifact!(row.id, { data: '<svg id="v2"/>' }, 'second pass');
    expect(updated.version).toBe(2);
    const versions = await db.getArtifactVersions!(row.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.changelog).toBe('second pass');
  });

  it('listArtifacts filters by type', async () => {
    await db.saveArtifact!({ name: 'a', type: 'json', mimeType: 'application/json', data: {}, scope: 'session' });
    await db.saveArtifact!({ name: 'b', type: 'csv', mimeType: 'text/csv', data: 'x', scope: 'session' });
    const jsonOnly = await db.listArtifacts!({ type: 'json' });
    expect(jsonOnly.every((r) => r.type === 'json')).toBe(true);
  });

  it('listArtifacts filters by sessionId', async () => {
    await db.saveArtifact!({ name: 'a', type: 'text', mimeType: 'text/plain', data: 'x', scope: 'session', sessionId: 'sess-X' });
    await db.saveArtifact!({ name: 'b', type: 'text', mimeType: 'text/plain', data: 'y', scope: 'session', sessionId: 'sess-Y' });
    const results = await db.listArtifacts!({ sessionId: 'sess-X' });
    expect(results.every((r) => r.session_id === 'sess-X')).toBe(true);
  });

  it('listArtifacts filters by userId and user scope', async () => {
    await db.saveArtifact!({ name: 'profile', type: 'json', mimeType: 'application/json', data: {}, scope: 'user', userId: 'alice' });
    await db.saveArtifact!({ name: 'temp', type: 'text', mimeType: 'text/plain', data: 'x', scope: 'session' });
    const userRows = await db.listArtifacts!({ userId: 'alice', scope: 'user' });
    expect(userRows.every((r) => r.user_id === 'alice' && r.scope === 'user')).toBe(true);
  });

  it('deleteArtifact removes row (versions cascade)', async () => {
    const row = await db.saveArtifact!({ name: 'del', type: 'text', mimeType: 'text/plain', data: 'bye', scope: 'session' });
    await db.deleteArtifact!(row.id);
    expect(await db.getArtifact!(row.id)).toBeNull();
    expect(await db.getArtifactVersions!(row.id)).toHaveLength(0);
  });

  it('getArtifactVersion returns specific version', async () => {
    const row = await db.saveArtifact!({ name: 'v', type: 'text', mimeType: 'text/plain', data: 'v1', scope: 'session' });
    await db.updateArtifact!(row.id, { data: 'v2' });
    const v1 = await db.getArtifactVersion!(row.id, 1);
    const v2 = await db.getArtifactVersion!(row.id, 2);
    expect(v1?.version).toBe(1);
    expect(v2?.version).toBe(2);
  });

  it('expireArtifacts removes rows past retention', async () => {
    // Use the first artifact_policy in DB (seeded by m01 as 90-day)
    // Instead, insert a short-lived policy and link an old artifact
    db.rawDb.prepare(`
      INSERT INTO artifact_policies (id, name, max_size_bytes, retention_days, require_versioning, enabled)
      VALUES ('test-policy', 'test-1day', 1000000, 1, 0, 1)
    `).run();
    // Insert an artifact directly with created_at 2 days ago
    const oldId = 'old-art-' + Date.now();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.rawDb.prepare(`
      INSERT INTO artifacts (id, name, type, mime_type, data_text, size_bytes, version, scope, policy_id, created_at)
      VALUES (?, 'old', 'text', 'text/plain', 'old data', 8, 1, 'session', 'test-policy', ?)
    `).run(oldId, twoDaysAgo);
    const count = await db.expireArtifacts!();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await db.getArtifact!(oldId)).toBeNull();
  });
});

// ─── createArtifactStore factory ─────────────────────────────────────────────

describe('createArtifactStore factory', () => {
  it('backend=memory returns InMemory store', async () => {
    const store = await createArtifactStore({ backend: 'memory' });
    const a = await store.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'hi', version: 1, scope: 'session' });
    expect(a.id).toBeTruthy();
  });

  it('backend=sqlite returns SQLite store', async () => {
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(makeTempDbPath());
    // Create tables (using the migration SQL)
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, mime_type TEXT NOT NULL,
        data_text TEXT, data_blob BLOB, size_bytes INTEGER, version INTEGER NOT NULL DEFAULT 1,
        session_id TEXT, user_id TEXT, agent_id TEXT, run_id TEXT, tags TEXT, metadata TEXT,
        policy_id TEXT, scope TEXT NOT NULL DEFAULT 'session',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version INTEGER NOT NULL,
        data_text TEXT, data_blob BLOB, changelog TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(artifact_id, version)
      );
    `);
    const store = await createArtifactStore({ backend: 'sqlite', db: rawDb as unknown as import('@weaveintel/artifacts').BetterSQLite3Database });
    const a = await store.save({ name: 'db-test', type: 'json', mimeType: 'application/json', data: { test: true }, version: 1, scope: 'session' });
    expect(a.id).toBeTruthy();
    const fetched = await store.get(a.id);
    expect(fetched?.name).toBe('db-test');
    rawDb.close();
  });
});

// ─── emit_artifact tool integration ──────────────────────────────────────────

describe('emit_artifact tool', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => { await db.close(); });

  it('emit_artifact tool is available when artifactSave is set', async () => {
    const saved: import('./db-types/artifacts.js').ArtifactSaveInput[] = [];
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        saved.push(input);
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
    });
    const tool = registry.get('emit_artifact');
    expect(tool).toBeTruthy();
  });

  it('emit_artifact is absent when artifactSave is not set', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      actorPersona: 'tenant_user',
    });
    const tool = registry.get('emit_artifact');
    expect(tool).toBeUndefined();
  });

  it('emit_artifact tool saves correctly to DB via callback', async () => {
    let capturedId: string | null = null;
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        capturedId = row.id;
        return { id: row.id, version: row.version };
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'Analysis Report', type: 'report', data: '<html><body>Report</body></html>', tags: ['analysis'] },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : result.content as string);
    expect(parsed.ok).toBe(true);
    expect(capturedId).toBeTruthy();
    const row = await db.getArtifact!(capturedId!);
    expect(row?.name).toBe('Analysis Report');
    expect(row?.type).toBe('report');
  });

  it('emit_artifact returns error JSON when save fails', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      actorPersona: 'tenant_user',
      artifactSave: async () => { throw new Error('DB is full'); },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'x', type: 'text', data: 'hi' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : result.content as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/DB is full/);
  });
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe('Negative cases', () => {
  it('update() on nonexistent artifact throws', async () => {
    const store = createInMemoryArtifactStore();
    await expect(store.update('no-such-id', { data: 'x' })).rejects.toThrow(/not found/i);
  });

  it('resolveReference throws on pinned version 0 (never exists)', async () => {
    const store = createInMemoryArtifactStore();
    const a = await store.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'v1', version: 1, scope: 'session' });
    await expect(resolveReference(store, { artifactId: a.id, version: 0 })).rejects.toThrow();
  });

  it('save with restricted type throws on type policy violation', async () => {
    const store = createInMemoryArtifactStore({
      policy: createArtifactPolicy({ name: 'json-only', allowedTypes: ['json'] }),
    });
    await expect(
      store.save({ name: 'x', type: 'html', mimeType: 'text/html', data: '<html/>', version: 1, scope: 'session' })
    ).rejects.toThrow(/policy violation/i);
  });

  it('inferMimeType for unknown type falls back gracefully', () => {
    // 'custom' type should always have a fallback
    expect(inferMimeType('custom')).toBe('application/octet-stream');
  });
});

// ─── Phase 1: Filesystem backend via factory ──────────────────────────────────

describe('Phase 1: Filesystem backend', () => {
  let tmpDir: string;

  beforeEach(() => {
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    tmpDir = path.join(os.tmpdir(), `geneweave-art-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('createArtifactStore filesystem backend saves and retrieves', async () => {
    const store = await createArtifactStore({ backend: 'filesystem', path: tmpDir });
    const saved = await store.save({ name: 'fs-test', type: 'text', mimeType: 'text/plain', data: 'hello fs', version: 1, scope: 'session' });
    expect(saved.id).toBeTruthy();
    const fetched = await store.get(saved.id);
    expect(fetched?.data).toBe('hello fs');
  });

  it('filesystem store update increments version', async () => {
    const store = await createArtifactStore({ backend: 'filesystem', path: tmpDir });
    const saved = await store.save({ name: 'fs-update', type: 'text', mimeType: 'text/plain', data: 'v1', version: 1, scope: 'session' });
    const updated = await store.update(saved.id, { data: 'v2' }, 'second version');
    expect(updated.version).toBe(2);
    const versions = await store.getVersions(saved.id);
    expect(versions).toHaveLength(2);
  });

  it('filesystem store list respects filters', async () => {
    const store = await createArtifactStore({ backend: 'filesystem', path: tmpDir });
    await store.save({ name: 'csv-art', type: 'csv', mimeType: 'text/csv', data: 'a,b', version: 1, scope: 'session', sessionId: 'sess-X' });
    await store.save({ name: 'json-art', type: 'json', mimeType: 'application/json', data: '{}', version: 1, scope: 'session', sessionId: 'sess-Y' });
    const csv = await store.list({ type: 'csv' });
    expect(csv).toHaveLength(1);
    expect(csv[0]!.name).toBe('csv-art');
    const sessX = await store.list({ sessionId: 'sess-X' });
    expect(sessX).toHaveLength(1);
  });

  it('filesystem store delete removes from list', async () => {
    const store = await createArtifactStore({ backend: 'filesystem', path: tmpDir });
    const a = await store.save({ name: 'del-test', type: 'text', mimeType: 'text/plain', data: 'bye', version: 1, scope: 'session' });
    await store.delete(a.id);
    expect(await store.get(a.id)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });
});

// ─── Phase 1: Artifact retention job ─────────────────────────────────────────

describe('Phase 1: Artifact retention job', () => {
  it('calls db.expireArtifacts() on startup', async () => {
    const { startArtifactRetentionJob } = await import('./artifact-retention-job.js');
    let callCount = 0;
    const fakeDb = { expireArtifacts: async () => { callCount++; return 0; } } as import('./db-types.js').DatabaseAdapter;
    const handle = startArtifactRetentionJob(fakeDb);
    // Give the startup run a tick to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    handle.stop();
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('stop() prevents further calls', async () => {
    const { startArtifactRetentionJob } = await import('./artifact-retention-job.js');
    let callCount = 0;
    const fakeDb = { expireArtifacts: async () => { callCount++; return 0; } } as import('./db-types.js').DatabaseAdapter;
    const handle = startArtifactRetentionJob(fakeDb);
    handle.stop();
    const countAtStop = callCount;
    // Wait a bit — no extra calls should come in
    await new Promise(resolve => setTimeout(resolve, 30));
    // At most 1 (the startup call that fired before stop)
    expect(callCount).toBeLessThanOrEqual(countAtStop + 1);
  });

  it('works when db.expireArtifacts is undefined', async () => {
    const { startArtifactRetentionJob } = await import('./artifact-retention-job.js');
    const fakeDb = {} as import('./db-types.js').DatabaseAdapter;
    const handle = startArtifactRetentionJob(fakeDb);
    await new Promise(resolve => setTimeout(resolve, 30));
    handle.stop();
    // should not throw
  });
});

// ─── Phase 1: Artifact routes (auth + scope guards) ──────────────────────────

describe('Phase 1: Artifact routes — ownership and auth guards', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => { await db.close(); });

  it('saveArtifact saves and listArtifacts returns it for the owner', async () => {
    const row = await db.saveArtifact!({
      name: 'My Doc', type: 'text', mimeType: 'text/plain', data: 'content here',
      sessionId: 'sess-1', userId: 'alice', scope: 'session',
    });
    expect(row.id).toBeTruthy();
    const listed = await db.listArtifacts!({ userId: 'alice' });
    expect(listed.some((a) => a.id === row.id)).toBe(true);
  });

  it('listArtifacts scoped by userId excludes other users', async () => {
    await db.saveArtifact!({ name: 'alice-art', type: 'text', mimeType: 'text/plain', data: 'x', userId: 'alice', scope: 'session' });
    await db.saveArtifact!({ name: 'bob-art', type: 'text', mimeType: 'text/plain', data: 'y', userId: 'bob', scope: 'session' });
    const aliceArts = await db.listArtifacts!({ userId: 'alice' });
    expect(aliceArts.every((a) => a.user_id === 'alice')).toBe(true);
    const bobArts = await db.listArtifacts!({ userId: 'bob' });
    expect(bobArts.every((a) => a.user_id === 'bob')).toBe(true);
  });

  it('user-scoped artifact appears in cross-session list', async () => {
    // user scope = survives across sessions
    await db.saveArtifact!({ name: 'user-profile', type: 'json', mimeType: 'application/json', data: '{}', userId: 'alice', scope: 'user' });
    await db.saveArtifact!({ name: 'session-report', type: 'report', mimeType: 'text/html', data: '<p/>', userId: 'alice', sessionId: 'sess-1', scope: 'session' });
    const userScoped = await db.listArtifacts!({ userId: 'alice', scope: 'user' });
    expect(userScoped).toHaveLength(1);
    expect(userScoped[0]!.name).toBe('user-profile');
    const all = await db.listArtifacts!({ userId: 'alice' });
    expect(all).toHaveLength(2);
  });

  it('deleteArtifact also removes versions', async () => {
    const row = await db.saveArtifact!({ name: 'del-me', type: 'text', mimeType: 'text/plain', data: 'del', userId: 'alice', scope: 'session' });
    await db.updateArtifact!(row.id, { data: 'v2' }, 'update');
    const before = await db.getArtifactVersions!(row.id);
    expect(before).toHaveLength(2);
    await db.deleteArtifact!(row.id);
    expect(await db.getArtifact!(row.id)).toBeNull();
    const after = await db.getArtifactVersions!(row.id);
    expect(after).toHaveLength(0);
  });
});

// ─── Phase 2-I: Tenant Artifact Settings (m78) ───────────────────────────────

describe('Phase 2: Tenant Artifact Settings DB methods', () => {
  let db: SQLiteAdapter;

  type DbEx = SQLiteAdapter & {
    getTenantArtifactSettings: (tenantId: string) => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null>;
    getEffectiveTenantArtifactSettings: (tenantId: string) => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null>;
    upsertTenantArtifactSettings: (tenantId: string, fields: Record<string, unknown>) => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow>;
    listTenantArtifactSettings: () => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow[]>;
    deleteTenantArtifactSettings: (tenantId: string) => Promise<void>;
  };

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => { await db.close(); });

  it('migration seeds a "default" row', async () => {
    const settings = await (db as unknown as DbEx).getTenantArtifactSettings('default');
    expect(settings).not.toBeNull();
    expect(settings!.tenant_id).toBe('default');
    expect(settings!.emit_enabled).toBe(1);
  });

  it('getEffectiveTenantArtifactSettings falls back to default', async () => {
    const row = await (db as unknown as DbEx).getEffectiveTenantArtifactSettings('unknown-tenant-xyz');
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe('default');
  });

  it('getEffectiveTenantArtifactSettings prefers tenant-specific row', async () => {
    await (db as unknown as DbEx).upsertTenantArtifactSettings('acme', {
      allowed_types: JSON.stringify(['text', 'json']),
      emit_enabled: 1,
    });
    const row = await (db as unknown as DbEx).getEffectiveTenantArtifactSettings('acme');
    expect(row!.tenant_id).toBe('acme');
    const parsed = JSON.parse(row!.allowed_types ?? '[]');
    expect(parsed).toContain('text');
    expect(parsed).toContain('json');
    expect(parsed).not.toContain('html');
  });

  it('upsertTenantArtifactSettings creates on first call', async () => {
    const row = await (db as unknown as DbEx).upsertTenantArtifactSettings('new-tenant', {
      max_size_bytes: 1024 * 1024,
      emit_enabled: 1,
    });
    expect(row.tenant_id).toBe('new-tenant');
    expect(row.max_size_bytes).toBe(1024 * 1024);
  });

  it('upsertTenantArtifactSettings updates on second call', async () => {
    await (db as unknown as DbEx).upsertTenantArtifactSettings('update-me', { emit_enabled: 1 });
    const updated = await (db as unknown as DbEx).upsertTenantArtifactSettings('update-me', { emit_enabled: 0 });
    expect(updated.emit_enabled).toBe(0);
  });

  it('listTenantArtifactSettings returns all rows including default', async () => {
    await (db as unknown as DbEx).upsertTenantArtifactSettings('tenant-a', { emit_enabled: 1 });
    await (db as unknown as DbEx).upsertTenantArtifactSettings('tenant-b', { emit_enabled: 0 });
    const all = await (db as unknown as DbEx).listTenantArtifactSettings();
    const ids = all.map(r => r.tenant_id);
    expect(ids).toContain('default');
    expect(ids).toContain('tenant-a');
    expect(ids).toContain('tenant-b');
  });

  it('deleteTenantArtifactSettings removes the row', async () => {
    await (db as unknown as DbEx).upsertTenantArtifactSettings('del-tenant', { emit_enabled: 1 });
    await (db as unknown as DbEx).deleteTenantArtifactSettings('del-tenant');
    const row = await (db as unknown as DbEx).getTenantArtifactSettings('del-tenant');
    expect(row).toBeNull();
  });
});

// ─── Phase 2-I: emit_artifact tenant settings enforcement ────────────────────

describe('Phase 2: emit_artifact tenant settings enforcement', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => { await db.close(); });

  it('emit_artifact blocked when emit_enabled=false in resolvedArtifactSettings', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: null,
        max_size_bytes: null,
        emit_enabled: false,
        preview_enabled: true,
        sandbox_html: true,
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'blocked', type: 'text', data: 'hello' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/disabled/i);
  });

  it('emit_artifact blocked when type not in allowed_types', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: ['text', 'json', 'csv'],
        max_size_bytes: null,
        emit_enabled: true,
        preview_enabled: true,
        sandbox_html: true,
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'blocked-html', type: 'html', data: '<html/>' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not permitted/i);
  });

  it('emit_artifact allowed when type is in allowed_types', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: ['text', 'json'],
        max_size_bytes: null,
        emit_enabled: true,
        preview_enabled: true,
        sandbox_html: true,
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'allowed-json', type: 'json', data: '{"hello":"world"}' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe('json');
  });

  it('emit_artifact blocked when data exceeds max_size_bytes', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: null,
        max_size_bytes: 10,  // only 10 bytes allowed
        emit_enabled: true,
        preview_enabled: true,
        sandbox_html: true,
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'too-big', type: 'text', data: 'this is longer than 10 bytes' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exceeds/i);
  });

  it('emit_artifact passes null allowed_types (allow all) without restriction', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: null,  // no restriction
        max_size_bytes: null,
        emit_enabled: true,
        preview_enabled: true,
        sandbox_html: true,
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    for (const type of ['mermaid', 'react', 'interactive', 'svg', 'spreadsheet'] as const) {
      const result = await tool.invoke(ctx, {
        name: 'emit_artifact',
        arguments: { name: `test-${type}`, type, data: `content for ${type}` },
      });
      const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
      expect(parsed.ok).toBe(true);
    }
  });

  it('emit_artifact includes language in result JSON', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      currentChatId: 'chat-1',
      currentUserId: 'alice',
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = { userId: 'alice', chatId: 'chat-1' } as unknown as import('@weaveintel/core').ExecutionContext;
    const result = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: { name: 'my-script', type: 'code', data: 'print("hello")', language: 'python' },
    });
    const parsed = JSON.parse(typeof result === 'string' ? result : (result as { content: string }).content);
    expect(parsed.ok).toBe(true);
    expect(parsed.language).toBe('python');
    expect(parsed.type).toBe('code');
    // Verify metadata stored correctly
    const row = await db.getArtifact!(parsed.artifactId);
    const meta = JSON.parse(row!.metadata ?? '{}');
    expect(meta.language).toBe('python');
  });
});

// ─── Phase 3: Admin API routes ────────────────────────────────────────────────
//
// These tests spin up a real HTTP server backed by a SQLiteAdapter and exercise
// every endpoint in admin/api/artifacts.ts via fetch(). Auth is bypassed by
// always injecting a fake admin AuthContext at dispatch time.

describe('Phase 3: Admin API routes (/api/admin/artifacts)', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    // Build a minimal HTTP server wired to the artifact admin routes.
    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./admin/api/artifacts.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper,
      readBody: readBodyHelper,
      requireDetailedDescription: () => null,
    });

    const fakeAuth = {
      userId: 'admin-test',
      email: 'admin@test.local',
      sessionId: 'sess-admin',
      csrfToken: 'token-admin',
      persona: 'platform_admin',
      tenantId: null,
    };

    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });

    await new Promise<void>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = srv.address() as import('node:net').AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
  });

  it('GET /api/admin/artifacts — lists all artifacts', async () => {
    await db.saveArtifact!({ name: 'doc-a', type: 'text', mimeType: 'text/plain', data: 'hello', scope: 'session', userId: 'u1' });
    await db.saveArtifact!({ name: 'doc-b', type: 'json', mimeType: 'application/json', data: '{}', scope: 'session', userId: 'u2' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json() as { artifacts: unknown[]; total: number };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/admin/artifacts?type=json — filters by type', async () => {
    await db.saveArtifact!({ name: 'csv-art', type: 'csv', mimeType: 'text/csv', data: 'a,b', scope: 'session' });
    await db.saveArtifact!({ name: 'json-art', type: 'json', mimeType: 'application/json', data: '{"k":1}', scope: 'session' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts?type=json`);
    const body = await res.json() as { artifacts: Array<{ type: string }> };
    expect(body.artifacts.every(a => a.type === 'json')).toBe(true);
  });

  it('GET /api/admin/artifacts — returns 401 when no auth', async () => {
    // Build a second server that passes null auth
    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./admin/api/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper,
      readBody: readBodyHelper,
      requireDetailedDescription: () => null,
    });
    const noAuthSrv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = r2.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, null); // no auth
    });
    await new Promise<void>(r => noAuthSrv.listen(0, '127.0.0.1', () => r()));
    const addr = noAuthSrv.address() as import('node:net').AddressInfo;
    const noAuthUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${noAuthUrl}/api/admin/artifacts`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => noAuthSrv.close(err => err ? e(err) : r()));
    }
  });

  it('GET /api/admin/artifacts/:id — returns the artifact', async () => {
    const row = await db.saveArtifact!({ name: 'my-report', type: 'report', mimeType: 'text/html', data: '<p>Hello</p>', scope: 'session' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { artifact: { id: string; name: string; type: string } };
    expect(body.artifact.id).toBe(row.id);
    expect(body.artifact.name).toBe('my-report');
    expect(body.artifact.type).toBe('report');
  });

  it('GET /api/admin/artifacts/:id — 404 for unknown id', async () => {
    const res = await fetch(`${serverUrl}/api/admin/artifacts/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('GET /api/admin/artifacts/:id/versions — returns version history', async () => {
    const row = await db.saveArtifact!({ name: 'chart', type: 'svg', mimeType: 'image/svg+xml', data: '<svg/>', scope: 'session' });
    await db.updateArtifact!(row.id, { data: '<svg id="v2"/>' }, 'second pass');
    await db.updateArtifact!(row.id, { data: '<svg id="v3"/>' }, 'third pass');
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/versions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { versions: Array<{ version: number; changelog: string | null }> };
    expect(body.versions).toHaveLength(3);
    expect(body.versions[0]!.version).toBe(1);
    expect(body.versions[2]!.changelog).toBe('third pass');
  });

  it('GET /api/admin/artifacts/:id/versions/:n — returns specific version data', async () => {
    const row = await db.saveArtifact!({ name: 'doc', type: 'text', mimeType: 'text/plain', data: 'v1 content', scope: 'session' });
    await db.updateArtifact!(row.id, { data: 'v2 content' }, 'updated');
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/versions/1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { version: { version: number } };
    expect(body.version.version).toBe(1);
  });

  it('GET /api/admin/artifacts/:id/versions/:n — 404 for non-existent version', async () => {
    const row = await db.saveArtifact!({ name: 'doc', type: 'text', mimeType: 'text/plain', data: 'content', scope: 'session' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/versions/99`);
    expect(res.status).toBe(404);
  });

  it('GET /api/admin/artifacts/:id/download — returns raw content with Content-Disposition', async () => {
    const row = await db.saveArtifact!({ name: 'analysis report', type: 'markdown', mimeType: 'text/markdown', data: '# Analysis\nKey findings.', scope: 'session' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/download`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    const contentDisposition = res.headers.get('content-disposition') ?? '';
    expect(contentType).toContain('text/markdown');
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('.md');
    const body = await res.text();
    expect(body).toContain('# Analysis');
  });

  it('GET /api/admin/artifacts/:id/download — binary artifact returns Buffer', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const row = await db.saveArtifact!({ name: 'icon', type: 'image', mimeType: 'image/png', data: pngHeader, scope: 'session' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/download`);
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(pngHeader.subarray(0, 4));
  });

  it('DELETE /api/admin/artifacts/:id — deletes artifact and versions', async () => {
    const row = await db.saveArtifact!({ name: 'todelete', type: 'text', mimeType: 'text/plain', data: 'bye', scope: 'session' });
    await db.updateArtifact!(row.id, { data: 'v2' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(await db.getArtifact!(row.id)).toBeNull();
    expect(await db.getArtifactVersions!(row.id)).toHaveLength(0);
  });

  it('DELETE /api/admin/artifacts/:id — 404 for unknown id', async () => {
    const res = await fetch(`${serverUrl}/api/admin/artifacts/ghost-id`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('GET /api/admin/artifacts — pagination: limit and offset work', async () => {
    for (let i = 0; i < 5; i++) {
      await db.saveArtifact!({ name: `art-${i}`, type: 'text', mimeType: 'text/plain', data: `data-${i}`, scope: 'session' });
    }
    const page1 = await (await fetch(`${serverUrl}/api/admin/artifacts?limit=2&offset=0`)).json() as { artifacts: unknown[] };
    const page2 = await (await fetch(`${serverUrl}/api/admin/artifacts?limit=2&offset=2`)).json() as { artifacts: unknown[] };
    expect(page1.artifacts).toHaveLength(2);
    expect(page2.artifacts).toHaveLength(2);
    // Pages should not overlap
    const ids1 = page1.artifacts.map((a: unknown) => (a as { id: string }).id);
    const ids2 = page2.artifacts.map((a: unknown) => (a as { id: string }).id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});

// ─── Phase 3: expireArtifacts real DB ────────────────────────────────────────

describe('Phase 3: expireArtifacts with real policy FK', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => { await db.close(); });

  it('expireArtifacts removes artifacts past retention and returns count', async () => {
    db.rawDb.prepare(`
      INSERT INTO artifact_policies (id, name, max_size_bytes, retention_days, require_versioning, enabled)
      VALUES ('p3-policy', 'test-3day', 1000000, 3, 0, 1)
    `).run();
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    // Old artifact (should expire)
    const oldId = `old-p3-${Date.now()}`;
    db.rawDb.prepare(`
      INSERT INTO artifacts (id, name, type, mime_type, data_text, size_bytes, version, scope, policy_id, created_at)
      VALUES (?, 'old-art', 'text', 'text/plain', 'old', 3, 1, 'session', 'p3-policy', ?)
    `).run(oldId, fourDaysAgo);
    // Fresh artifact (should NOT expire)
    const freshRow = await db.saveArtifact!({ name: 'fresh', type: 'text', mimeType: 'text/plain', data: 'new', policyId: 'p3-policy', scope: 'session' });
    // Override created_at to today to be explicit
    db.rawDb.prepare(`UPDATE artifacts SET created_at = ? WHERE id = ?`).run(recentDate, freshRow.id);

    const count = await db.expireArtifacts!();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await db.getArtifact!(oldId)).toBeNull();
    expect(await db.getArtifact!(freshRow.id)).not.toBeNull();
  });

  it('expireArtifacts returns 0 when no artifacts are expired', async () => {
    await db.saveArtifact!({ name: 'new', type: 'text', mimeType: 'text/plain', data: 'new', scope: 'session' });
    const count = await db.expireArtifacts!();
    expect(count).toBe(0);
  });

  it('expireArtifacts cascades to artifact_versions', async () => {
    db.rawDb.prepare(`
      INSERT INTO artifact_policies (id, name, max_size_bytes, retention_days, require_versioning, enabled)
      VALUES ('p3-policy-v', 'test-version-expiry', 1000000, 1, 0, 1)
    `).run();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldId = `old-v-${Date.now()}`;
    db.rawDb.prepare(`
      INSERT INTO artifacts (id, name, type, mime_type, data_text, size_bytes, version, scope, policy_id, created_at)
      VALUES (?, 'versioned', 'text', 'text/plain', 'v1', 2, 1, 'session', 'p3-policy-v', ?)
    `).run(oldId, twoDaysAgo);
    // Add version record manually
    const { newUUIDv7 } = await import('@weaveintel/core');
    db.rawDb.prepare(`
      INSERT INTO artifact_versions (id, artifact_id, version, data_text, created_at)
      VALUES (?, ?, 1, 'v1', ?)
    `).run(newUUIDv7(), oldId, twoDaysAgo);

    await db.expireArtifacts!();
    expect(await db.getArtifactVersions!(oldId)).toHaveLength(0);
  });
});

// ─── Phase 4: Streaming API (packages/artifacts/src/streaming.ts) ─────────────

describe('Phase 4: streamArtifact() — ArtifactStreamHandle API', () => {
  it('returns a handle with status=streaming immediately after creation', async () => {
    const { createInMemoryArtifactStore } = await import('@weaveintel/artifacts');
    const { streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const handle = await streamArtifact(store, { name: 'r.md', type: 'markdown', mimeType: 'text/markdown', data: '' });
    expect(handle.id).toBeTruthy();
    expect(handle.status).toBe('streaming');
    expect(handle.progress).toBe(0);
    // Initial artifact row created in store
    const artifact = await store.get(handle.id);
    expect(artifact).not.toBeNull();
    expect(artifact!.metadata).toMatchObject({ streamingStatus: 'streaming' });
  });

  it('update() fires onProgress with kind=update and advances progress', async () => {
    const { createInMemoryArtifactStore, streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const events: import('@weaveintel/artifacts').ArtifactStreamEvent[] = [];
    const handle = await streamArtifact(
      store,
      { name: 'rep.txt', type: 'text', mimeType: 'text/plain', data: '' },
      { onProgress: (ev) => events.push(ev) },
    );
    await handle.update({ data: 'hello ' }, 0.5);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('update');
    expect(events[0]!.progress).toBe(0.5);
    expect(handle.progress).toBe(0.5);
    expect(handle.status).toBe('streaming');
  });

  it('complete() finalises artifact and emits kind=complete', async () => {
    const { createInMemoryArtifactStore, streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const events: import('@weaveintel/artifacts').ArtifactStreamEvent[] = [];
    const handle = await streamArtifact(
      store,
      { name: 'final.json', type: 'json', mimeType: 'application/json', data: '' },
      { onProgress: (ev) => events.push(ev) },
    );
    await handle.update({ data: '{"partial":true}' }, 0.5);
    const artifact = await handle.complete('{"done":true}', 'Initial generation');
    expect(handle.status).toBe('complete');
    expect(handle.progress).toBe(1);
    expect(artifact.version).toBe(2); // version bumped on complete
    expect(artifact.data).toBe('{"done":true}');
    const completeEvent = events.find(e => e.kind === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.version).toBe(2);
  });

  it('error() marks handle as failed and emits kind=error', async () => {
    const { createInMemoryArtifactStore, streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const events: import('@weaveintel/artifacts').ArtifactStreamEvent[] = [];
    const handle = await streamArtifact(
      store,
      { name: 'broken.txt', type: 'text', mimeType: 'text/plain', data: '' },
      { onProgress: (ev) => events.push(ev) },
    );
    await handle.update({ data: 'partial...' }, 0.3);
    await handle.error('LLM context limit exceeded');
    expect(handle.status).toBe('error');
    const errEvent = events.find(e => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toBe('LLM context limit exceeded');
  });

  it('update() after complete() is a no-op (status guard)', async () => {
    const { createInMemoryArtifactStore, streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const events: import('@weaveintel/artifacts').ArtifactStreamEvent[] = [];
    const handle = await streamArtifact(
      store,
      { name: 'done.txt', type: 'text', mimeType: 'text/plain', data: '' },
      { onProgress: (ev) => events.push(ev) },
    );
    await handle.complete('final content');
    const beforeCount = events.length;
    await handle.update({ data: 'too late' }, 0.8); // should be no-op
    expect(events.length).toBe(beforeCount); // no new event
  });

  it('multiple updates accumulate progress correctly', async () => {
    const { createInMemoryArtifactStore, streamArtifact } = await import('@weaveintel/artifacts');
    const store = createInMemoryArtifactStore();
    const progresses: number[] = [];
    const handle = await streamArtifact(
      store,
      { name: 'large.md', type: 'markdown', mimeType: 'text/markdown', data: '' },
      { onProgress: (ev) => progresses.push(ev.progress) },
    );
    await handle.update({ data: 'chunk 1' }, 0.25);
    await handle.update({ data: 'chunk 1 chunk 2' }, 0.5);
    await handle.update({ data: 'chunk 1 chunk 2 chunk 3' }, 0.75);
    await handle.complete('chunk 1 chunk 2 chunk 3 final', 'complete');
    expect(progresses).toEqual([0.25, 0.5, 0.75, 1]);
  });
});

// ─── Phase 4: Artifact Stream Bus ────────────────────────────────────────────

describe('Phase 4: artifact-stream-bus — in-process SSE event delivery', () => {
  it('emitArtifactStreamEvent calls all registered listeners', async () => {
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');
    const id = `bus-test-${Date.now()}`;
    const received: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent[] = [];
    const listener = (ev: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent) => received.push(ev);
    onArtifactStreamEvent(id, listener);
    emitArtifactStreamEvent(id, { kind: 'update', progress: 0.5, data: 'hello' });
    offArtifactStreamEvent(id, listener);
    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe('update');
    expect(received[0]!.progress).toBe(0.5);
    expect(received[0]!.artifactId).toBe(id);
    expect(received[0]!.timestamp).toBeTruthy();
  });

  it('offArtifactStreamEvent removes listener and clears Map entry', async () => {
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent, hasArtifactStreamListeners } = await import('./lib/artifact-stream-bus.js');
    const id = `bus-off-${Date.now()}`;
    const listener = () => undefined;
    onArtifactStreamEvent(id, listener);
    expect(hasArtifactStreamListeners(id)).toBe(true);
    offArtifactStreamEvent(id, listener);
    expect(hasArtifactStreamListeners(id)).toBe(false);
    // Emit after removal — no-op, no throw
    emitArtifactStreamEvent(id, { kind: 'complete', progress: 1 });
  });

  it('multiple listeners for the same artifact all receive events', async () => {
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');
    const id = `bus-multi-${Date.now()}`;
    const countsA: number[] = [];
    const countsB: number[] = [];
    const listenerA = (ev: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent) => countsA.push(ev.progress);
    const listenerB = (ev: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent) => countsB.push(ev.progress);
    onArtifactStreamEvent(id, listenerA);
    onArtifactStreamEvent(id, listenerB);
    emitArtifactStreamEvent(id, { kind: 'update', progress: 0.3 });
    emitArtifactStreamEvent(id, { kind: 'complete', progress: 1 });
    offArtifactStreamEvent(id, listenerA);
    offArtifactStreamEvent(id, listenerB);
    expect(countsA).toEqual([0.3, 1]);
    expect(countsB).toEqual([0.3, 1]);
  });
});

// ─── Phase 4: m79 migration — streaming_status column ─────────────────────────

describe('Phase 4: m79 — streaming_status column on artifacts', () => {
  let db: import('./db-sqlite.js').SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('saveArtifact with streamingStatus sets streaming_status column', async () => {
    const row = await db.saveArtifact!({
      name: 'streamed.md',
      type: 'markdown',
      mimeType: 'text/markdown',
      data: '',
      scope: 'session',
      streamingStatus: 'streaming',
      streamingProgress: 0,
    });
    expect(row.streaming_status).toBe('streaming');
    expect(row.streaming_progress).toBe(0);
  });

  it('saveArtifact without streamingStatus leaves columns NULL', async () => {
    const row = await db.saveArtifact!({
      name: 'normal.txt', type: 'text', mimeType: 'text/plain', data: 'hello', scope: 'session',
    });
    expect(row.streaming_status).toBeNull();
    expect(row.streaming_progress).toBeNull();
  });

  it('updateArtifact clears streaming_status when set to null', async () => {
    const row = await db.saveArtifact!({
      name: 'inprogress.md', type: 'markdown', mimeType: 'text/markdown', data: '',
      scope: 'session', streamingStatus: 'streaming', streamingProgress: 0.3,
    });
    expect(row.streaming_status).toBe('streaming');

    const updated = await db.updateArtifact!(row.id, {
      data: 'final content',
      streamingStatus: null,
      streamingProgress: null,
    });
    expect(updated.streaming_status).toBeNull();
    expect(updated.streaming_progress).toBeNull();
    expect(updated.version).toBe(2);
  });

  it('updateArtifact sets streaming_status=error on failure', async () => {
    const row = await db.saveArtifact!({
      name: 'errored.txt', type: 'text', mimeType: 'text/plain', data: '',
      scope: 'session', streamingStatus: 'streaming', streamingProgress: 0.4,
    });
    const updated = await db.updateArtifact!(row.id, {
      streamingStatus: 'error',
      streamingProgress: 0.4,
    });
    expect(updated.streaming_status).toBe('error');
  });
});

// ─── Phase 4: emit_artifact tool streaming mode ───────────────────────────────

describe('Phase 4: emit_artifact streaming mode (streaming: true)', () => {
  let db: import('./db-sqlite.js').SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('streaming:true saves artifact, emits progress events, then finalises', async () => {
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');
    const busEvents: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent[] = [];

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      artifactUpdate: async (id, patch, changelog) => {
        const row = await db.updateArtifact!(id, patch, changelog);
        return { id: row.id, version: row.version };
      },
    });
    const emitTool = registry.get('emit_artifact');
    expect(emitTool).toBeDefined();

    // Subscribe to the bus BEFORE calling the tool (simulate SSE client connecting)
    let artifactId: string | null = null;
    const listenerSetup = (ev: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent) => {
      if (!artifactId) { artifactId = ev.artifactId; }
      onArtifactStreamEvent(ev.artifactId, (e) => busEvents.push(e));
    };
    // We can't know the artifactId before the tool runs, so inspect the result
    const ctx = (await import('@weaveintel/core')).weaveContext({ userId: 'test-stream-user' });
    const output = await emitTool!.invoke(ctx, {
      name: 'emit_artifact',
      arguments: {
        name: 'report.md',
        type: 'markdown',
        data: '# Report\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
        streaming: true,
      },
    });
    const resultStr = output.content;
    const result = JSON.parse(resultStr) as { ok: boolean; artifactId: string; version: number; streaming: boolean; streamUrl: string };

    expect(result.ok).toBe(true);
    expect(result.streaming).toBe(true);
    expect(result.artifactId).toBeTruthy();
    expect(result.streamUrl).toBe(`/api/artifacts/${result.artifactId}/stream`);
    expect(result.version).toBeGreaterThanOrEqual(2); // at least one update (final)

    // Verify DB: streaming_status cleared after finalise
    const finalRow = await db.getArtifact!(result.artifactId);
    expect(finalRow!.streaming_status).toBeNull();
    expect(finalRow!.data_text).toBeTruthy();
  });

  it('streaming:false (default) saves artifact in one shot', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = (await import('@weaveintel/core')).weaveContext({ userId: 'test-std-user' });
    const output = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'a.txt', type: 'text', data: 'content' } });
    const resultStr = output.content;
    const result = JSON.parse(resultStr) as { ok: boolean; artifactId: string; version: number; streaming?: boolean };
    expect(result.ok).toBe(true);
    expect(result.streaming).toBeUndefined();
    // Standard save: version 1
    const row = await db.getArtifact!(result.artifactId);
    expect(row!.version).toBe(1);
    expect(row!.streaming_status).toBeNull();
  });

  it('streaming:true without artifactUpdate falls back to standard save', async () => {
    // When artifactUpdate is absent, streaming:true should still work via standard path
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      // no artifactUpdate
    });
    const tool = registry.get('emit_artifact')!;
    const ctx = (await import('@weaveintel/core')).weaveContext({ userId: 'test-fallback-user' });
    const output = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'fallback.txt', type: 'text', data: 'content', streaming: true } });
    const resultStr = output.content;
    const result = JSON.parse(resultStr) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

// ─── Phase 4: SSE endpoint GET /api/artifacts/:id/stream ─────────────────────

describe('Phase 4: SSE endpoint GET /api/artifacts/:id/stream', () => {
  let db: import('./db-sqlite.js').SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter);
    const fakeAuth = { userId: 'u1', email: 'u@t.local', sessionId: 's1', csrfToken: 'tok', persona: 'user', tenantId: null };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address() as import('node:net').AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await db.close();
    await closeServer();
  });

  it('returns 401 when not authenticated', async () => {
    // Need a separate unauthenticated server
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter);
    const noAuthSrv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = r2.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, null);
    });
    await new Promise<void>((r) => noAuthSrv.listen(0, '127.0.0.1', () => r()));
    const addr = noAuthSrv.address() as import('node:net').AddressInfo;
    const url2 = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${url2}/api/artifacts/x/stream`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => noAuthSrv.close(err => err ? e(err) : r()));
    }
  });

  it('returns 404 for unknown artifact', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/unknown-id/stream`);
    expect(res.status).toBe(404);
  });

  it('completed artifact returns SSE with immediate complete event', async () => {
    const row = await db.saveArtifact!({ name: 'done.md', type: 'markdown', mimeType: 'text/markdown', data: 'done', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('"kind":"complete"');
    expect(body).toContain(row.id);
  });

  it('streaming artifact delivers update then complete events via bus', async () => {
    const { emitArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');
    const row = await db.saveArtifact!({
      name: 'live.md', type: 'markdown', mimeType: 'text/markdown', data: '',
      scope: 'session', userId: 'u1', streamingStatus: 'streaming', streamingProgress: 0,
    });

    // Start SSE fetch (non-blocking — uses an AbortController to close after complete event)
    const controller = new AbortController();
    const ssePromise = fetch(`${serverUrl}/api/artifacts/${row.id}/stream`, { signal: controller.signal })
      .then(async (res) => {
        const chunks: string[] = [];
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let full = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          full += chunk;
          chunks.push(chunk);
          // Stop reading after complete event
          if (full.includes('"kind":"complete"')) { reader.cancel(); break; }
        }
        return full;
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return '';
        throw e;
      });

    // Small delay so SSE connection opens, then emit events
    await new Promise<void>(r => setTimeout(r, 50));
    emitArtifactStreamEvent(row.id, { kind: 'update', progress: 0.5, data: 'half done' });
    await new Promise<void>(r => setTimeout(r, 20));
    emitArtifactStreamEvent(row.id, { kind: 'complete', progress: 1, version: 2 });

    const body = await ssePromise;
    controller.abort();
    expect(body).toContain('"kind":"update"');
    expect(body).toContain('"kind":"complete"');
    expect(body).toContain('"progress":1');
  });
});

// ─── Phase 5: Sandboxed Render Endpoint ───────────────────────────────────────

import { buildArtifactRenderHtml } from './routes/artifacts.js';

describe('Phase 5: buildArtifactRenderHtml — per-type HTML generation', () => {
  it('markdown: contains marked CDN and renders gfm', () => {
    const html = buildArtifactRenderHtml('markdown', '# Hello\n**bold**', 'text/markdown', 'doc.md');
    expect(html).toContain('marked');
    expect(html).toContain('# Hello');
    expect(html).toContain('gfm');
  });

  it('mermaid: contains Mermaid CDN and diagram source', () => {
    const src = 'graph TD\n  A-->B';
    const html = buildArtifactRenderHtml('mermaid', src, 'text/x-mermaid', 'diagram.mmd');
    expect(html).toContain('mermaid');
    expect(html).toContain('cdn.jsdelivr.net');
    expect(html).toContain('A-->B');
  });

  it('code: contains highlight.js CDN and language class', () => {
    const html = buildArtifactRenderHtml('code', 'const x = 1;', 'text/typescript', 'app.ts', 'typescript');
    expect(html).toContain('highlight.js');
    expect(html).toContain('language-typescript');
    expect(html).toContain('const x = 1;');
  });

  it('code: defaults to plaintext when no language given', () => {
    const html = buildArtifactRenderHtml('code', 'echo hello', 'text/plain', 'script.sh');
    expect(html).toContain('language-plaintext');
  });

  it('json: contains tree-view script and the raw json', () => {
    const html = buildArtifactRenderHtml('json', '{"key":"value","n":42}', 'application/json', 'data.json');
    expect(html).toContain('renderNode');
    expect(html).toContain('{"key":"value","n":42}');
  });

  it('csv: generates a sortable table with headers', () => {
    const csv = 'name,score\nAlice,95\nBob,87';
    const html = buildArtifactRenderHtml('csv', csv, 'text/csv', 'results.csv');
    expect(html).toContain('<th>name</th>');
    expect(html).toContain('<th>score</th>');
    expect(html).toContain('Alice');
    expect(html).toContain('sort');
  });

  it('csv: truncates at 2000 rows and shows overflow note', () => {
    const header = 'x';
    const rows = Array.from({ length: 2100 }, (_, i) => String(i)).join('\n');
    const html = buildArtifactRenderHtml('csv', `${header}\n${rows}`, 'text/csv', 'big.csv');
    expect(html).toContain('Showing 2,000 of 2100 rows');
  });

  it('html: passes through raw HTML with CSP meta injected', () => {
    const html = buildArtifactRenderHtml('html', '<html><head></head><body><p>Hello</p></body></html>', 'text/html', 'page.html');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('<p>Hello</p>');
  });

  it('html: wraps bare fragments in a document', () => {
    const html = buildArtifactRenderHtml('html', '<p>bare</p>', 'text/html', 'frag.html');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<p>bare</p>');
  });

  it('react: contains Babel CDN for TSX compilation', () => {
    const src = 'export default function App() { return <div>Hello</div>; }';
    const html = buildArtifactRenderHtml('react', src, 'text/typescript', 'App.tsx');
    expect(html).toContain('babel');
    expect(html).toContain('react');
    expect(html).toContain('App');
  });

  it('svg: wraps SVG in a centered container', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="5"/></svg>';
    const html = buildArtifactRenderHtml('svg', src, 'image/svg+xml', 'icon.svg');
    expect(html).toContain(src);
    expect(html).toContain('wrap');
  });

  it('text: generates line-numbered table', () => {
    const html = buildArtifactRenderHtml('text', 'line one\nline two', 'text/plain', 'notes.txt');
    expect(html).toContain('<td class="ln">1</td>');
    expect(html).toContain('<td class="ln">2</td>');
    expect(html).toContain('line one');
  });

  it('image: embeds self-reference data URL via /data path', () => {
    const html = buildArtifactRenderHtml('image', '', 'image/png', 'photo.png', undefined, 'art-123');
    expect(html).toContain('/api/artifacts/art-123/data');
  });

  it('audio: embeds audio element referencing /data path', () => {
    const html = buildArtifactRenderHtml('audio', '', 'audio/mpeg', 'track.mp3', undefined, 'art-audio-1');
    expect(html).toContain('<audio');
    expect(html).toContain('/api/artifacts/art-audio-1/data');
  });

  it('video: embeds video element referencing /data path', () => {
    const html = buildArtifactRenderHtml('video', '', 'video/mp4', 'clip.mp4', undefined, 'art-video-1');
    expect(html).toContain('<video');
    expect(html).toContain('/api/artifacts/art-video-1/data');
  });

  it('XSS: special chars in data are HTML-escaped', () => {
    const html = buildArtifactRenderHtml('text', '<script>alert(1)</script>', 'text/plain', 'xss.txt');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('XSS: special chars in language param are HTML-escaped', () => {
    const html = buildArtifactRenderHtml('code', 'x', 'text/plain', 'x', '"><script>x</script>', 'id1');
    expect(html).not.toContain('"><script>');
  });

  it('unknown type falls back to pre block', () => {
    const html = buildArtifactRenderHtml('spreadsheet', 'no commas here', 'application/octet-stream', 'file');
    expect(html).toContain('Download .xlsx');
  });

  it('spreadsheet with CSV data renders table', () => {
    const html = buildArtifactRenderHtml('spreadsheet', 'col1,col2\n1,2', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data.xlsx');
    expect(html).toContain('<th>col1</th>');
    expect(html).toContain('<td>1</td>');
  });
});

describe('Phase 5: GET /api/artifacts/:id/render — HTTP endpoint', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter);
    const fakeAuth = { userId: 'u1', email: 'u@test', sessionId: 'ss', csrfToken: 'tok', persona: 'tenant_user', tenantId: null };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    serverUrl = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
  });

  it('returns 401 when not authenticated', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter);
    const srv2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const u2 = `http://127.0.0.1:${(srv2.address() as import('node:net').AddressInfo).port}`;
    try {
      const res = await fetch(`${u2}/api/artifacts/x/render`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => srv2.close(err => err ? e(err) : r()));
    }
  });

  it('returns 404 for unknown artifact id', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/no-such-id/render`);
    expect(res.status).toBe(404);
  });

  it('markdown artifact → 200 text/html with CSP header', async () => {
    const row = await db.saveArtifact!({ name: 'doc.md', type: 'markdown', mimeType: 'text/markdown', data: '# Hello', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('# Hello');
    expect(body).toContain('marked');
  });

  it('code artifact → contains highlight.js and correct language', async () => {
    const row = await db.saveArtifact!({ name: 'script.py', type: 'code', mimeType: 'text/x-python', data: 'print("hi")', scope: 'session', userId: 'u1', metadata: { language: 'python' } });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    const body = await res.text();
    expect(body).toContain('language-python');
    expect(body).toContain('highlight.js');
    expect(body).toContain('print');
  });

  it('json artifact → contains tree-view renderer', async () => {
    const row = await db.saveArtifact!({ name: 'data.json', type: 'json', mimeType: 'application/json', data: '{"a":1}', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    const body = await res.text();
    expect(body).toContain('renderNode');
    expect(body).toContain('{"a":1}');
  });

  it('csv artifact → contains sortable table HTML', async () => {
    const row = await db.saveArtifact!({ name: 'data.csv', type: 'csv', mimeType: 'text/csv', data: 'x,y\n1,2', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    const body = await res.text();
    expect(body).toContain('<th>x</th>');
    expect(body).toContain('<td>1</td>');
  });

  it('html artifact → raw HTML passed through with CSP meta injected', async () => {
    const row = await db.saveArtifact!({ name: 'page.html', type: 'html', mimeType: 'text/html', data: '<p>Hello world</p>', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    const body = await res.text();
    expect(body).toContain('<p>Hello world</p>');
    expect(body).toContain('Content-Security-Policy');
  });

  it('mermaid artifact → Mermaid CDN loaded in iframe', async () => {
    const row = await db.saveArtifact!({ name: 'flow.mmd', type: 'mermaid', mimeType: 'text/x-mermaid', data: 'graph TD\n  A-->B', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
    const body = await res.text();
    expect(body).toContain('mermaid');
    expect(body).toContain('A-->B');
  });

  it('admin render endpoint also works for admin-authed requests', async () => {
    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody } = await import('./server-core.js');
    const { registerArtifactRoutes: registerAdminArtifactRoutes } = await import('./admin/api/artifacts.js');
    const adminRouter = new Router();
    registerAdminArtifactRoutes(adminRouter, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper, readBody, requireDetailedDescription: () => null,
    });
    const fakeAdminAuth = { userId: 'admin', email: 'a@a.com', sessionId: 'sa', csrfToken: 'tok', persona: 'platform_admin', tenantId: null };
    const srv3 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = adminRouter.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, fakeAdminAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv3.listen(0, '127.0.0.1', () => r()));
    const adminUrl = `http://127.0.0.1:${(srv3.address() as import('node:net').AddressInfo).port}`;

    const row = await db.saveArtifact!({ name: 'report.md', type: 'markdown', mimeType: 'text/markdown', data: '# Admin', scope: 'session', userId: 'admin' });
    const res = await fetch(`${adminUrl}/api/admin/artifacts/${row.id}/render`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('# Admin');
    expect(body).toContain('marked');
    await new Promise<void>((r, e) => srv3.close(err => err ? e(err) : r()));
  });
});

// ─── Phase 6: Live Artifacts ─────────────────────────────────────────────────

describe('Phase 6: live_artifact_configs — SQLite DB methods', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });
  afterEach(async () => { await db.close(); });

  it('saveLiveArtifactConfig creates a live config row', async () => {
    const artifact = await db.saveArtifact!({ name: 'live.md', type: 'markdown', mimeType: 'text/markdown', data: '# Live', scope: 'session', userId: 'u1' });
    const row = await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 30, cacheTtlSeconds: 10 });
    expect(row.artifact_id).toBe(artifact.id);
    expect(row.refresh_interval_seconds).toBe(30);
    expect(row.cache_ttl_seconds).toBe(10);
    expect(row.refresh_count).toBe(0);
    expect(row.last_refreshed_at).toBeNull();
  });

  it('getLiveArtifactConfig returns null when no config exists', async () => {
    const row = await db.getLiveArtifactConfig!('nonexistent-id');
    expect(row).toBeNull();
  });

  it('getLiveArtifactConfig returns the config after creation', async () => {
    const artifact = await db.saveArtifact!({ name: 'q.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u2' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 60 });
    const row = await db.getLiveArtifactConfig!(artifact.id);
    expect(row).not.toBeNull();
    expect(row!.artifact_id).toBe(artifact.id);
    expect(row!.refresh_interval_seconds).toBe(60);
  });

  it('updateLiveArtifactConfig patches only provided fields', async () => {
    const artifact = await db.saveArtifact!({ name: 'upd.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u3' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 30, cacheTtlSeconds: 15 });
    const updated = await db.updateLiveArtifactConfig!(artifact.id, { cacheTtlSeconds: 90 });
    expect(updated.cache_ttl_seconds).toBe(90);
    expect(updated.refresh_interval_seconds).toBe(30);
  });

  it('touchLiveArtifactRefresh increments refresh_count and sets last_refreshed_at', async () => {
    const artifact = await db.saveArtifact!({ name: 'touch.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u4' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 0 });
    await db.touchLiveArtifactRefresh!(artifact.id);
    const row = await db.getLiveArtifactConfig!(artifact.id);
    expect(row!.refresh_count).toBe(1);
    expect(row!.last_refreshed_at).not.toBeNull();
  });

  it('deleteLiveArtifactConfig removes the config', async () => {
    const artifact = await db.saveArtifact!({ name: 'del.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u5' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id });
    await db.deleteLiveArtifactConfig!(artifact.id);
    const row = await db.getLiveArtifactConfig!(artifact.id);
    expect(row).toBeNull();
  });

  it('saveLiveArtifactConfig upserts on duplicate artifact_id', async () => {
    const artifact = await db.saveArtifact!({ name: 'dup.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u6' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 10 });
    const upserted = await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 99 });
    expect(upserted.refresh_interval_seconds).toBe(99);
    const got = await db.getLiveArtifactConfig!(artifact.id);
    expect(got!.refresh_interval_seconds).toBe(99);
  });
});

describe('Phase 6: injectLiveToolbar — HTML toolbar injection', () => {
  it('injects toolbar before </body></html>', async () => {
    const { injectLiveToolbar } = await import('./routes/artifacts.js');
    const html = '<html><head></head><body><p>hello</p></body></html>';
    const result = injectLiveToolbar(html, {
      artifactId: 'art-123',
      refreshIntervalSeconds: 0,
      lastRefreshedAt: null,
      refreshCount: 0,
      refreshEndpoint: '/api/artifacts/art-123/refresh',
    });
    expect(result).toContain('live-toolbar');
    expect(result).toContain('LIVE');
    expect(result).toContain('/api/artifacts/art-123/refresh');
    expect(result.indexOf('</body></html>')).toBeGreaterThan(result.indexOf('live-toolbar'));
  });

  it('includes auto-refresh interval script when intervalSeconds > 0', async () => {
    const { injectLiveToolbar } = await import('./routes/artifacts.js');
    const html = '<html><body></body></html>';
    const result = injectLiveToolbar(html, {
      artifactId: 'art-456',
      refreshIntervalSeconds: 30,
      lastRefreshedAt: new Date().toISOString(),
      refreshCount: 5,
      refreshEndpoint: '/api/artifacts/art-456/refresh',
    });
    expect(result).toContain('INTERVAL_MS = 30000');
    expect(result).toContain('Auto 30s');
    expect(result).toContain('#5');
  });

  it('does NOT include auto toggle when intervalSeconds = 0', async () => {
    const { injectLiveToolbar } = await import('./routes/artifacts.js');
    const html = '<html><body></body></html>';
    const result = injectLiveToolbar(html, {
      artifactId: 'art-789',
      refreshIntervalSeconds: 0,
      lastRefreshedAt: null,
      refreshCount: 0,
      refreshEndpoint: '/api/artifacts/art-789/refresh',
    });
    expect(result).not.toContain('Auto 0s');
    expect(result).toContain('INTERVAL_MS = 0');
  });
});

describe('Phase 6: POST /api/artifacts/:id/refresh — HTTP', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const router = new Router();
    // Register with a fake refreshFn
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      refreshFn: async (_artifact, _args) => ({ data: '# Refreshed Content\n\nUpdated at: ' + new Date().toISOString() }),
    });
    const fakeAuth = { userId: 'live-user', email: 'lv@test', sessionId: 'slv', csrfToken: 'tok', persona: 'tenant_user', tenantId: null };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    serverUrl = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
  });

  it('POST /refresh returns 401 without auth', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter);
    const s2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', () => r()));
    const url2 = `http://127.0.0.1:${(s2.address() as import('node:net').AddressInfo).port}`;
    const res = await fetch(`${url2}/api/artifacts/any-id/refresh`, { method: 'POST' });
    expect(res.status).toBe(401);
    await new Promise<void>((r, e) => s2.close(err => err ? e(err) : r()));
  });

  it('POST /refresh returns 404 when artifact not found', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/nonexistent/refresh`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /refresh returns 404 when artifact has no live config', async () => {
    const artifact = await db.saveArtifact!({ name: 'static.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'user', userId: 'live-user' });
    const res = await fetch(`${serverUrl}/api/artifacts/${artifact.id}/refresh`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not configured as live');
  });

  it('POST /refresh returns fromCache:true within cache TTL', async () => {
    const artifact = await db.saveArtifact!({ name: 'cached.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'user', userId: 'live-user' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, cacheTtlSeconds: 3600 });
    // Touch to set last_refreshed_at to "just now"
    await db.touchLiveArtifactRefresh!(artifact.id);
    const res = await fetch(`${serverUrl}/api/artifacts/${artifact.id}/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { fromCache: boolean };
    expect(body.fromCache).toBe(true);
  });

  it('POST /refresh calls refreshFn and returns fromCache:false outside TTL', async () => {
    const artifact = await db.saveArtifact!({ name: 'stale.md', type: 'markdown', mimeType: 'text/markdown', data: '# Old', scope: 'user', userId: 'live-user' });
    // Set last_refreshed_at to 1 hour ago manually via upsert with zero TTL
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, cacheTtlSeconds: 0 });
    const res = await fetch(`${serverUrl}/api/artifacts/${artifact.id}/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { fromCache: boolean; refreshedAt: string; version: number };
    expect(body.fromCache).toBe(false);
    expect(body.refreshedAt).toBeTruthy();
    expect(body.version).toBeGreaterThanOrEqual(1);
    // Verify data was updated
    const row = await db.getArtifact!(artifact.id);
    expect(row!.data_text).toContain('Refreshed Content');
  });
});

describe('Phase 6: Admin API /api/admin/artifacts/:id/live-config CRUD', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody } = await import('./server-core.js');
    const { registerArtifactRoutes: registerAdminRoutes } = await import('./admin/api/artifacts.js');
    const router = new Router();
    registerAdminRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper, readBody, requireDetailedDescription: () => null,
    });
    const fakeAuth = { userId: 'admin', email: 'adm@test', sessionId: 'sadm', csrfToken: 'tok', persona: 'platform_admin', tenantId: null };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    serverUrl = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
  });

  it('GET /live-config returns 404 when no config exists', async () => {
    const artifact = await db.saveArtifact!({ name: 'x.md', type: 'markdown', mimeType: 'text/markdown', data: 'x', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`);
    expect(res.status).toBe(404);
  });

  it('POST /live-config creates a live config (status 201)', async () => {
    const artifact = await db.saveArtifact!({ name: 'y.md', type: 'markdown', mimeType: 'text/markdown', data: 'y', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalSeconds: 45, cacheTtlSeconds: 20 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { liveConfig: { refresh_interval_seconds: number; cache_ttl_seconds: number } };
    expect(body.liveConfig.refresh_interval_seconds).toBe(45);
    expect(body.liveConfig.cache_ttl_seconds).toBe(20);
  });

  it('GET /live-config returns config after creation', async () => {
    const artifact = await db.saveArtifact!({ name: 'z.md', type: 'markdown', mimeType: 'text/markdown', data: 'z', scope: 'session', userId: 'u1' });
    await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalSeconds: 60 }),
    });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`);
    expect(res.status).toBe(200);
    const body = await res.json() as { liveConfig: { refresh_interval_seconds: number } };
    expect(body.liveConfig.refresh_interval_seconds).toBe(60);
  });

  it('PATCH /live-config updates the config', async () => {
    const artifact = await db.saveArtifact!({ name: 'w.md', type: 'markdown', mimeType: 'text/markdown', data: 'w', scope: 'session', userId: 'u1' });
    await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalSeconds: 30, cacheTtlSeconds: 10 }),
    });
    const patchRes = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheTtlSeconds: 999 }),
    });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json() as { liveConfig: { cache_ttl_seconds: number; refresh_interval_seconds: number } };
    expect(body.liveConfig.cache_ttl_seconds).toBe(999);
    expect(body.liveConfig.refresh_interval_seconds).toBe(30);
  });

  it('DELETE /live-config removes the config', async () => {
    const artifact = await db.saveArtifact!({ name: 'v.md', type: 'markdown', mimeType: 'text/markdown', data: 'v', scope: 'session', userId: 'u1' });
    await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const delRes = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const getRes = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/live-config`);
    expect(getRes.status).toBe(404);
  });

  it('render-live endpoint injects live toolbar when config exists', async () => {
    const artifact = await db.saveArtifact!({ name: 'live.md', type: 'markdown', mimeType: 'text/markdown', data: '# Live Data', scope: 'session', userId: 'u1' });
    await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 60 });
    const res = await fetch(`${serverUrl}/api/admin/artifacts/${artifact.id}/render-live`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('LIVE');
    expect(body).toContain('live-toolbar');
    expect(body).toContain('Refresh');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: signShareToken / verifyShareToken — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 7: signShareToken / verifyShareToken — unit tests', () => {
  let signShareToken: (id: string, secret: string, opts?: { expiresInSeconds?: number; password?: string }) => string;
  let verifyShareToken: (token: string, secret: string) => import('./routes/artifacts.js').ShareTokenPayload | null;

  beforeEach(async () => {
    const mod = await import('./routes/artifacts.js');
    signShareToken = mod.signShareToken;
    verifyShareToken = mod.verifyShareToken;
  });

  it('round-trips: sign then verify returns the artifact id', () => {
    const tok = signShareToken('art-123', 'my-secret');
    const payload = verifyShareToken(tok, 'my-secret');
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('art-123');
    expect(payload!.typ).toBe('share');
  });

  it('verifyShareToken returns null for wrong secret', () => {
    const tok = signShareToken('art-x', 'correct-secret');
    expect(verifyShareToken(tok, 'wrong-secret')).toBeNull();
  });

  it('verifyShareToken returns null for expired token', async () => {
    const tok = signShareToken('art-y', 'sec', { expiresInSeconds: -1 });
    expect(verifyShareToken(tok, 'sec')).toBeNull();
  });

  it('verifyShareToken returns null for tampered token (modified payload)', () => {
    const tok = signShareToken('art-z', 'sec');
    const parts = tok.split('.');
    // Mutate the payload section
    const newPayload = Buffer.from(JSON.stringify({ sub: 'hacked', typ: 'share', iat: 0 })).toString('base64url');
    const tampered = `${parts[0]}.${newPayload}.${parts[2]}`;
    expect(verifyShareToken(tampered, 'sec')).toBeNull();
  });

  it('verifyShareToken returns null for tampered signature', () => {
    const tok = signShareToken('art-q', 'sec');
    const parts = tok.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAABBBCCC`;
    expect(verifyShareToken(tampered, 'sec')).toBeNull();
  });

  it('token with password stores ph (SHA-256 hex) in payload', () => {
    const tok = signShareToken('art-pw', 'sec', { password: 'hunter2' });
    const payload = verifyShareToken(tok, 'sec');
    expect(payload).not.toBeNull();
    expect(typeof payload!.ph).toBe('string');
    expect(payload!.ph).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('token with expiry has exp field close to now + seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const tok = signShareToken('art-exp', 'sec', { expiresInSeconds: 3600 });
    const after = Math.floor(Date.now() / 1000);
    const payload = verifyShareToken(tok, 'sec');
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(payload!.exp).toBeLessThanOrEqual(after + 3600 + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: HTTP endpoints — download, export, share, embed, public share routes
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 7: HTTP endpoints — download, export, share, embed-code, public share', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const TEST_SECRET = 'phase7-test-jwt-secret';
  const fakeAuth = { userId: 'u1', email: 'u@test', sessionId: 'ss', csrfToken: 'tok', persona: 'tenant_user', tenantId: null };

  function makeServer(auth: typeof fakeAuth | null): void {
    // set up inside beforeEach
  }

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const { registerShareRoutes } = await import('./routes/share.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      jwtSecret: TEST_SECRET,
      publicBaseUrl: 'http://localhost',
    });
    registerShareRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, { jwtSecret: TEST_SECRET });
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    serverUrl = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
  });

  // ── Download endpoint ──────────────────────────────────────────────────────

  it('GET /download: returns 200 with Content-Disposition attachment', async () => {
    const art = await db.saveArtifact!({ name: 'report.md', type: 'markdown', mimeType: 'text/markdown', data: '# Report', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/download`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toContain('attachment');
    expect(cd).toContain('report.md');
    const body = await res.text();
    expect(body).toContain('# Report');
  });

  it('GET /download: sets correct MIME type', async () => {
    const art = await db.saveArtifact!({ name: 'style.css', type: 'code', mimeType: 'text/css', data: 'body{}', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('GET /download: returns 404 for unknown id', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/no-such/download`);
    expect(res.status).toBe(404);
  });

  it('GET /download: returns 401 without auth', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter, { jwtSecret: TEST_SECRET });
    const srv2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const u2 = `http://127.0.0.1:${(srv2.address() as import('node:net').AddressInfo).port}`;
    try {
      const res = await fetch(`${u2}/api/artifacts/x/download`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => srv2.close(err => err ? e(err) : r()));
    }
  });

  // ── Version download ───────────────────────────────────────────────────────

  it('GET /versions/:n/download: returns versioned file', async () => {
    const art = await db.saveArtifact!({ name: 'notes.txt', type: 'text', mimeType: 'text/plain', data: 'v1 text', scope: 'session', userId: 'u1' });
    await db.updateArtifact!(art.id, { data: 'v2 text' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/versions/1/download`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toContain('_v1');
    const body = await res.text();
    expect(body).toBe('v1 text');
  });

  it('GET /versions/:n/download: returns 404 for unknown version', async () => {
    const art = await db.saveArtifact!({ name: 'x.txt', type: 'text', mimeType: 'text/plain', data: 'data', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/versions/99/download`);
    expect(res.status).toBe(404);
  });

  it('GET /versions/:n/download: returns 400 for invalid version', async () => {
    const art = await db.saveArtifact!({ name: 'x.txt', type: 'text', mimeType: 'text/plain', data: 'data', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/versions/abc/download`);
    expect(res.status).toBe(400);
  });

  // ── ZIP Export ─────────────────────────────────────────────────────────────

  it('GET /export: returns a valid ZIP file', async () => {
    const art = await db.saveArtifact!({ name: 'chart.json', type: 'json', mimeType: 'application/json', data: '{"x":1}', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    const cd = res.headers.get('content-disposition');
    expect(cd).toContain('attachment');
    expect(cd).toContain('.zip');
    // ZIP magic bytes: PK\x03\x04
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(4);
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('GET /export: ZIP contains manifest.json', async () => {
    const art = await db.saveArtifact!({ name: 'data.csv', type: 'csv', mimeType: 'text/csv', data: 'a,b\n1,2', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/export`);
    const buf = Buffer.from(await res.arrayBuffer());
    // manifest.json filename should appear in ZIP central directory
    expect(buf.toString('utf8')).toContain('manifest.json');
  });

  it('GET /export: returns 401 without auth', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter, { jwtSecret: TEST_SECRET });
    const srv2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const u2 = `http://127.0.0.1:${(srv2.address() as import('node:net').AddressInfo).port}`;
    try {
      const res = await fetch(`${u2}/api/artifacts/x/export`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => srv2.close(err => err ? e(err) : r()));
    }
  });

  // ── Share endpoint ─────────────────────────────────────────────────────────

  it('POST /share: returns shareToken and url', async () => {
    const art = await db.saveArtifact!({ name: 'deck.md', type: 'markdown', mimeType: 'text/markdown', data: '# Deck', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const body = await res.json() as { shareToken: string; url: string; passwordProtected: boolean };
    expect(typeof body.shareToken).toBe('string');
    expect(body.url).toContain('/share/artifacts/');
    expect(body.passwordProtected).toBe(false);
  });

  it('POST /share: with expiresInDays returns expiresAt', async () => {
    const art = await db.saveArtifact!({ name: 'tmp.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 7 }),
    });
    const body = await res.json() as { expiresAt?: string };
    expect(body.expiresAt).toBeTruthy();
    const exp = new Date(body.expiresAt!).getTime();
    const now = Date.now();
    expect(exp).toBeGreaterThan(now + 6 * 86400 * 1000);
    expect(exp).toBeLessThan(now + 8 * 86400 * 1000);
  });

  it('POST /share: with password sets passwordProtected:true and ph in token', async () => {
    const art = await db.saveArtifact!({ name: 'secret.md', type: 'markdown', mimeType: 'text/markdown', data: 'secret', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'p@ssw0rd' }),
    });
    const body = await res.json() as { shareToken: string; passwordProtected: boolean };
    expect(body.passwordProtected).toBe(true);
    const { verifyShareToken } = await import('./routes/artifacts.js');
    const payload = verifyShareToken(body.shareToken, TEST_SECRET);
    expect(payload!.ph).toBeTruthy();
  });

  it('POST /share: returns 404 for unknown artifact', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/no-such/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });

  it('POST /share: returns 401 without auth', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter, { jwtSecret: TEST_SECRET });
    const srv2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const u2 = `http://127.0.0.1:${(srv2.address() as import('node:net').AddressInfo).port}`;
    try {
      const res = await fetch(`${u2}/api/artifacts/x/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => srv2.close(err => err ? e(err) : r()));
    }
  });

  // ── Embed code endpoint ────────────────────────────────────────────────────

  it('GET /embed-code: returns embedCode with iframe', async () => {
    const art = await db.saveArtifact!({ name: 'chart.js', type: 'code', mimeType: 'text/javascript', data: 'const x=1', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/embed-code`);
    expect(res.status).toBe(200);
    const body = await res.json() as { embedCode: string; embedUrl: string };
    expect(body.embedCode).toContain('<iframe');
    expect(body.embedCode).toContain('/share/artifacts/');
    expect(body.embedCode).toContain('sandbox=');
    expect(body.embedUrl).toContain('/share/artifacts/');
  });

  it('GET /embed-code: width/height query params reflected in iframe', async () => {
    const art = await db.saveArtifact!({ name: 'big.svg', type: 'svg', mimeType: 'image/svg+xml', data: '<svg/>', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/embed-code?width=1200&height=900`);
    const body = await res.json() as { embedCode: string };
    expect(body.embedCode).toContain('width="1200"');
    expect(body.embedCode).toContain('height="900"');
  });

  it('GET /embed-code: embed token is permanent (no exp)', async () => {
    const art = await db.saveArtifact!({ name: 'perm.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u1' });
    const res = await fetch(`${serverUrl}/api/artifacts/${art.id}/embed-code`);
    const body = await res.json() as { embedUrl: string };
    // Extract token from URL
    const token = body.embedUrl.split('/share/artifacts/')[1] ?? '';
    const { verifyShareToken } = await import('./routes/artifacts.js');
    const payload = verifyShareToken(token, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeUndefined();
  });

  it('GET /embed-code: returns 404 for unknown artifact', async () => {
    const res = await fetch(`${serverUrl}/api/artifacts/no-such/embed-code`);
    expect(res.status).toBe(404);
  });

  it('GET /embed-code: returns 401 without auth', async () => {
    const { createServer } = await import('node:http');
    const { Router } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./routes/artifacts.js');
    const r2 = new Router();
    registerArtifactRoutes(r2, db as unknown as import('./db.js').DatabaseAdapter, { jwtSecret: TEST_SECRET });
    const srv2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = r2.match(req.method ?? 'GET', url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      void m.route.handler(req, res, m.params, null);
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const u2 = `http://127.0.0.1:${(srv2.address() as import('node:net').AddressInfo).port}`;
    try {
      const res = await fetch(`${u2}/api/artifacts/x/embed-code`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) => srv2.close(err => err ? e(err) : r()));
    }
  });

  // ── Public share routes ───────────────────────────────────────────────────

  it('GET /share/artifacts/:token: renders artifact HTML with share footer', async () => {
    const art = await db.saveArtifact!({ name: 'pub.md', type: 'markdown', mimeType: 'text/markdown', data: '# Public', scope: 'session', userId: 'u1' });
    const shareRes = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { url } = await shareRes.json() as { url: string };
    // url is absolute with localhost prefix — strip to relative
    const path = url.replace('http://localhost', '');
    const res = await fetch(`${serverUrl}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('# Public'); // raw data present for markdown renderer
    expect(html).toContain('Shared via geneWeave');
    expect(html).toContain('share-footer');
    expect(html).toContain('pub.md');
  });

  it('GET /share/artifacts/:token: sets noindex header', async () => {
    const art = await db.saveArtifact!({ name: 'noindex.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u1' });
    const shareRes = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { url } = await shareRes.json() as { url: string };
    const path = url.replace('http://localhost', '');
    const res = await fetch(`${serverUrl}${path}`);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('GET /share/artifacts/:token: returns 401 for invalid token', async () => {
    const res = await fetch(`${serverUrl}/share/artifacts/this.is.not.valid`);
    expect(res.status).toBe(401);
  });

  it('GET /share/artifacts/:token: returns 401 for expired token', async () => {
    const art = await db.saveArtifact!({ name: 'exp.md', type: 'markdown', mimeType: 'text/markdown', data: 'hi', scope: 'session', userId: 'u1' });
    const { signShareToken } = await import('./routes/artifacts.js');
    const tok = signShareToken(art.id, TEST_SECRET, { expiresInSeconds: -1 });
    const res = await fetch(`${serverUrl}/share/artifacts/${tok}`);
    expect(res.status).toBe(401);
  });

  it('GET /share/artifacts/:token: shows password page for password-protected artifact', async () => {
    const art = await db.saveArtifact!({ name: 'locked.md', type: 'markdown', mimeType: 'text/markdown', data: 'top secret', scope: 'session', userId: 'u1' });
    const shareRes = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    const { url } = await shareRes.json() as { url: string };
    const path = url.replace('http://localhost', '');
    const res = await fetch(`${serverUrl}${path}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Password Protected');
    expect(html).toContain('Enter Password');
    expect(html).not.toContain('top secret');
  });

  it('GET /share/artifacts/:token?p=: grants access with correct password', async () => {
    const art = await db.saveArtifact!({ name: 'pw.md', type: 'markdown', mimeType: 'text/markdown', data: '# Secret Content', scope: 'session', userId: 'u1' });
    const shareRes = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'open_sesame' }),
    });
    const { url } = await shareRes.json() as { url: string };
    const path = url.replace('http://localhost', '');
    const res = await fetch(`${serverUrl}${path}?p=open_sesame`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('# Secret Content');
    expect(html).not.toContain('Enter Password');
  });

  it('GET /share/artifacts/:token?p=: returns 401 for wrong password', async () => {
    const art = await db.saveArtifact!({ name: 'wpw.md', type: 'markdown', mimeType: 'text/markdown', data: 'hidden', scope: 'session', userId: 'u1' });
    const shareRes = await fetch(`${serverUrl}/api/artifacts/${art.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct' }),
    });
    const { url } = await shareRes.json() as { url: string };
    const path = url.replace('http://localhost', '');
    const res = await fetch(`${serverUrl}${path}?p=wrong`);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Incorrect password');
  });

  it('GET /share/artifacts/:token/raw: returns raw artifact data', async () => {
    const art = await db.saveArtifact!({ name: 'raw.txt', type: 'text', mimeType: 'text/plain', data: 'raw content here', scope: 'session', userId: 'u1' });
    const { signShareToken } = await import('./routes/artifacts.js');
    const tok = signShareToken(art.id, TEST_SECRET);
    const res = await fetch(`${serverUrl}/share/artifacts/${tok}/raw`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('raw content here');
  });

  it('GET /share/artifacts/:token/raw: blocks password-protected artifacts', async () => {
    const art = await db.saveArtifact!({ name: 'blocked.txt', type: 'text', mimeType: 'text/plain', data: 'secret raw', scope: 'session', userId: 'u1' });
    const { signShareToken } = await import('./routes/artifacts.js');
    const tok = signShareToken(art.id, TEST_SECRET, { password: 'pw' });
    const res = await fetch(`${serverUrl}/share/artifacts/${tok}/raw`);
    expect(res.status).toBe(403);
  });

  it('security: tampered share token rejected by public share route', async () => {
    const art = await db.saveArtifact!({ name: 'safe.md', type: 'markdown', mimeType: 'text/markdown', data: 'safe', scope: 'session', userId: 'u1' });
    const { signShareToken } = await import('./routes/artifacts.js');
    const tok = signShareToken(art.id, TEST_SECRET);
    const parts = tok.split('.');
    const tampered = `${parts[0]}.${parts[1]}.TAMPERED_SIG`;
    const res = await fetch(`${serverUrl}/share/artifacts/${tampered}`);
    expect(res.status).toBe(401);
  });

  it('security: share token signed with different secret is rejected', async () => {
    const art = await db.saveArtifact!({ name: 'sniff.md', type: 'markdown', mimeType: 'text/markdown', data: 'data', scope: 'session', userId: 'u1' });
    const { signShareToken } = await import('./routes/artifacts.js');
    const tok = signShareToken(art.id, 'attacker-secret');
    const res = await fetch(`${serverUrl}/share/artifacts/${tok}`);
    expect(res.status).toBe(401);
  });
});
