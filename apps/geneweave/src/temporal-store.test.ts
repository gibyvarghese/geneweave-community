import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDatabaseAdapter } from './db.js';
import { createTemporalStore } from './temporal-store.js';

function makeTempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gw-temporal-'));
  return { dir, dbPath: join(dir, 'test.db') };
}

describe('geneweave temporal store persistence', () => {
  it('persists timer and reminder state in sqlite', async () => {
    const { dir, dbPath } = makeTempDbPath();
    const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });

    try {
      const store = createTemporalStore(db);
      const scope = 'user1:chat1';

      await store.saveTimer(scope, {
        id: 'timer-1',
        label: 'tea',
        durationMs: 60000,
        state: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        elapsedMs: 1000,
      });

      const timer = await store.getTimer(scope, 'timer-1');
      expect(timer).toBeTruthy();
      expect(timer?.label).toBe('tea');
      expect(timer?.state).toBe('running');

      const dueAt = new Date(Date.now() + 60_000).toISOString();
      await store.saveReminder(scope, {
        id: 'rem-1',
        text: 'join standup',
        dueAt,
        timezone: 'UTC',
        status: 'scheduled',
        createdAt: new Date().toISOString(),
      });

      const reminder = await store.getReminder(scope, 'rem-1');
      expect(reminder).toBeTruthy();
      expect(reminder?.status).toBe('scheduled');

      await store.saveReminder(scope, {
        ...reminder!,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
      });

      const list = await store.listReminders(scope);
      expect(list).toHaveLength(1);
      expect(list[0]?.status).toBe('cancelled');
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
