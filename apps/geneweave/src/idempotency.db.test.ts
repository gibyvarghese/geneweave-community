import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-idempotency-test-${Date.now()}-${randomUUID()}.db`;
}

describe('SQLite idempotency record persistence', () => {
  it('stores, fetches, expires, and trims persisted idempotency records', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    await db.createIdempotencyRecord({
      id: randomUUID(),
      key: 'hypotheses:key-1',
      result_json: JSON.stringify({ id: 'hv-1' }),
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    await db.createIdempotencyRecord({
      id: randomUUID(),
      key: 'hypotheses:key-2',
      result_json: JSON.stringify({ id: 'hv-2' }),
      expires_at: '2999-01-01T00:00:00.000Z',
    });

    const stored = await db.getIdempotencyRecordByKey('hypotheses:key-1');
    expect(stored?.key).toBe('hypotheses:key-1');

    await db.trimIdempotencyRecords(1);

    const remainingFirst = await db.getIdempotencyRecordByKey('hypotheses:key-1');
    const remainingSecond = await db.getIdempotencyRecordByKey('hypotheses:key-2');
    expect([remainingFirst?.key, remainingSecond?.key].filter(Boolean)).toHaveLength(1);

    await db.createIdempotencyRecord({
      id: randomUUID(),
      key: 'hypotheses:expired',
      result_json: JSON.stringify({ id: 'hv-expired' }),
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    await db.deleteExpiredIdempotencyRecords('2001-01-01T00:00:00.000Z');

    const expired = await db.getIdempotencyRecordByKey('hypotheses:expired');
    expect(expired).toBeNull();

    await db.clearIdempotencyRecords();
    expect(await db.getIdempotencyRecordByKey('hypotheses:key-1')).toBeNull();
    expect(await db.getIdempotencyRecordByKey('hypotheses:key-2')).toBeNull();

    await db.close();
  });
});