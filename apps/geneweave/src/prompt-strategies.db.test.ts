import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SQLiteAdapter } from './db-sqlite.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-prompt-strategy-test-${Date.now()}-${randomUUID()}.db`;
}

describe('SQLite prompt strategy CRUD', () => {
  it('seeds built-in prompt strategies', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();

    const strategies = await db.listPromptStrategies();
    const keys = new Set(strategies.map((strategy) => strategy.key));

    expect(strategies.length).toBeGreaterThanOrEqual(3);
    expect(keys.has('singlePass')).toBe(true);
    expect(keys.has('deliberate')).toBe(true);
    expect(keys.has('critiqueRevise')).toBe(true);
  });

  it('creates, reads, updates, and deletes a prompt strategy', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();

    const beforeCount = (await db.listPromptStrategies()).length;
    const id = `strategy-test-${randomUUID().slice(0, 8)}`;
    const key = `strategy-test-key-${randomUUID().slice(0, 8)}`;

    await db.createPromptStrategy({
      id,
      key,
      name: 'Test Strategy',
      description: 'CRUD test strategy',
      instruction_prefix: 'Prefix instruction',
      instruction_suffix: 'Suffix instruction',
      config: JSON.stringify({ mode: 'test' }),
      enabled: 1,
    });

    const created = await db.getPromptStrategy(id);
    expect(created).not.toBeNull();
    expect(created?.key).toBe(key);
    expect(created?.name).toBe('Test Strategy');

    const byKey = await db.getPromptStrategyByKey(key);
    expect(byKey?.id).toBe(id);

    await db.updatePromptStrategy(id, {
      name: 'Updated Test Strategy',
      instruction_suffix: 'Updated suffix instruction',
      config: JSON.stringify({ mode: 'test', updated: true }),
      enabled: 0,
    });

    const updated = await db.getPromptStrategy(id);
    expect(updated?.name).toBe('Updated Test Strategy');
    expect(updated?.instruction_suffix).toBe('Updated suffix instruction');
    expect(updated?.enabled).toBe(0);

    await db.deletePromptStrategy(id);

    const deleted = await db.getPromptStrategy(id);
    const afterCount = (await db.listPromptStrategies()).length;
    expect(deleted).toBeNull();
    expect(afterCount).toBe(beforeCount);
  });
});
