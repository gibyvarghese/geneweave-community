import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-oauth-state-test-${Date.now()}-${randomUUID()}.db`;
}

describe('SQLite OAuth flow state persistence', () => {
  it('stores, consumes once, and expires OAuth flow state values', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    const stateKey = `state-${randomUUID()}`;
    await db.createOAuthFlowState({
      id: randomUUID(),
      state_key: stateKey,
      user_id: null,
      provider: 'google',
      expires_at: '2999-01-01T00:00:00.000Z',
    });

    const consumed = await db.consumeOAuthFlowStateByKey(stateKey);
    expect(consumed?.state_key).toBe(stateKey);
    expect(consumed?.provider).toBe('google');

    const consumedAgain = await db.consumeOAuthFlowStateByKey(stateKey);
    expect(consumedAgain).toBeNull();

    await db.createOAuthFlowState({
      id: randomUUID(),
      state_key: 'state-expired',
      user_id: null,
      provider: 'github',
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    expect(await db.consumeOAuthFlowStateByKey('state-expired')).toBeNull();
    await db.deleteExpiredOAuthFlowStates('2001-01-01T00:00:00.000Z');

    await db.createOAuthFlowState({
      id: randomUUID(),
      state_key: 'state-delete',
      user_id: null,
      provider: 'microsoft',
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    await db.deleteOAuthFlowStateByKey('state-delete');
    expect(await db.consumeOAuthFlowStateByKey('state-delete')).toBeNull();

    await db.close();
  });
});
