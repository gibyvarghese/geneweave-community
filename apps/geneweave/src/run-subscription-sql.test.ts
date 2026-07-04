/**
 * Conformance + unit tests — geneWeave's SQL adapters for Collaboration Phase 3
 * (durable subscriptions, in-app feed) AND the transactional-outbox relay.
 *
 * The SQL SubscriptionManager + FeedStore run the SAME shared contracts the
 * in-memory reference adapters pass (one port, two interchangeable backends).
 * Then we exercise the outbox end-to-end: enqueue on terminal → relay drains →
 * in-app feed row + signed webhook fired; plus idempotency, retry/backoff,
 * dead-lettering, restart-safety, the SSRF guard, and the webhook signature.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { subscriptionManagerContract, type SubscriptionManager } from '@weaveintel/collab';
import { notificationFeedStoreContract } from '@weaveintel/notifications';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlSubscriptionManager, createSqlFeedStore } from './run-subscription-sql.js';
import {
  enqueueRunTerminalNotifications,
  createNotificationRelay,
  signWebhook,
  isSafeWebhookUrl,
  type WebhookSender,
} from './run-notifications-outbox.js';
import type { UserRunRow } from './db-types/adapter-me.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-sub-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'owner', email: 'owner@x.dev', name: 'Owner', passwordHash: 'x' });
  return db;
}
async function makeRun(db: SQLiteAdapter, id: string, status: 'running' | 'completed' | 'failed' = 'running'): Promise<UserRunRow> {
  await db.createUserRun({ id, user_id: 'owner', status, tenant_id: 'tA' }).catch(() => {});
  return (await db.getUserRunById(id))!;
}

// ─── Contract conformance (SQL adapters behind the shared ports) ────────────────

// run_subscriptions has a FK to user_runs, so wrap subscribe to ensure the run.
async function makeSubscriptionManager(): Promise<SubscriptionManager> {
  const db = await freshDb();
  const mgr = createSqlSubscriptionManager(db);
  return {
    ...mgr,
    subscribe: async (input) => { await makeRun(db, input.runId); return mgr.subscribe(input); },
  };
}
subscriptionManagerContract(makeSubscriptionManager, { describe, it, beforeEach, expect } as never);
notificationFeedStoreContract(async () => createSqlFeedStore(await freshDb()), { describe, it, beforeEach, expect } as never);

// ─── SSRF guard + webhook signature ─────────────────────────────────────────────

describe('isSafeWebhookUrl', () => {
  it('accepts public https and rejects private / loopback / metadata / non-https', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/x')).toBe(true);
    expect(isSafeWebhookUrl('http://hooks.example.com/x')).toBe(false);   // not https
    expect(isSafeWebhookUrl('https://localhost/x')).toBe(false);
    expect(isSafeWebhookUrl('https://127.0.0.1/x')).toBe(false);
    expect(isSafeWebhookUrl('https://10.0.0.5/x')).toBe(false);
    expect(isSafeWebhookUrl('https://192.168.1.10/x')).toBe(false);
    expect(isSafeWebhookUrl('https://172.16.0.9/x')).toBe(false);
    expect(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false); // cloud metadata
    expect(isSafeWebhookUrl('not a url')).toBe(false);
  });
});

describe('signWebhook (Standard Webhooks)', () => {
  it('produces verifiable v1 HMAC headers over id.timestamp.body', () => {
    const headers = signWebhook('evt-1', 1000, '{"a":1}', 'whsec_test');
    expect(headers['webhook-id']).toBe('evt-1');
    expect(headers['webhook-timestamp']).toBe('1000');
    const expected = createHmac('sha256', 'whsec_test').update('evt-1.1000.{"a":1}').digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${expected}`);
  });
});

// ─── Outbox relay — the durable, crash-safe delivery path ───────────────────────

describe('notification outbox relay', () => {
  it('enqueues on terminal and delivers an in-app feed row + a signed webhook', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'bob@x.dev', name: 'Bob', passwordHash: 'x' });
    const run = await makeRun(db, 'r1', 'completed');
    // bob subscribes over inapp + webhook; register his endpoint.
    await createSqlSubscriptionManager(db).subscribe({ runId: 'r1', tenantId: 'tA', userId: 'bob', channels: ['inapp', 'webhook'] });
    await db.createWebhookEndpoint({ id: 'wh1', tenant_id: 'tA', user_id: 'bob', url: 'https://hooks.example.com/bob', signing_secret: 'whsec_abc', created_at: Date.now() });

    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const sender: WebhookSender = async (url, body, headers) => { sent.push({ url, body, headers }); };
    const relay = createNotificationRelay({ db, webhookSender: sender });

    expect(await enqueueRunTerminalNotifications(db, run)).toBe(1);
    await relay.drainOnce();

    // In-app feed row landed for bob.
    const feed = await db.listNotificationFeed('tA', 'bob');
    expect(feed.length).toBe(1);
    expect(feed[0]!.title).toContain('completed');
    expect(feed[0]!.deep_link).toBe('geneweave://run/r1');
    // Webhook fired, signed, CloudEvents-shaped.
    expect(sent.length).toBe(1);
    expect(sent[0]!.url).toBe('https://hooks.example.com/bob');
    expect(sent[0]!.headers['webhook-signature']).toMatch(/^v1,/);
    expect(JSON.parse(sent[0]!.body).type).toBe('run.completed');
  });

  it('is idempotent: re-enqueue + re-drain never duplicates the feed row (at-least-once safe)', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'b@x.dev', name: 'Bob', passwordHash: 'x' });
    const run = await makeRun(db, 'r1', 'completed');
    await createSqlSubscriptionManager(db).subscribe({ runId: 'r1', tenantId: 'tA', userId: 'bob' });
    const relay = createNotificationRelay({ db, webhookSender: async () => {} });

    await enqueueRunTerminalNotifications(db, run);
    await relay.drainOnce();
    // Simulate a crash-and-retry: enqueue again (no-op due to UNIQUE) + reconcile.
    expect(await enqueueRunTerminalNotifications(db, run)).toBe(0);
    await relay.reconcile();
    expect((await db.listNotificationFeed('tA', 'bob')).length).toBe(1); // exactly one
  });

  it('retries a failing webhook with backoff, then dead-letters after the budget', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'b@x.dev', name: 'Bob', passwordHash: 'x' });
    const run = await makeRun(db, 'r1', 'failed');
    await createSqlSubscriptionManager(db).subscribe({ runId: 'r1', tenantId: 'tA', userId: 'bob', channels: ['inapp', 'webhook'] });
    await db.createWebhookEndpoint({ id: 'wh1', tenant_id: 'tA', user_id: 'bob', url: 'https://hooks.example.com/x', signing_secret: 's', created_at: Date.now() });

    let clock = 1_000_000;
    const relay = createNotificationRelay({ db, now: () => clock, webhookSender: async () => { throw new Error('boom 500'); } });
    await enqueueRunTerminalNotifications(db, run, clock);

    // Drain repeatedly, advancing the clock past each backoff, until dead-lettered.
    for (let i = 0; i < 8; i++) { await relay.drainOnce(); clock += 10 * 60_000; }
    const rows = await db.claimNotificationOutbox(clock + 1e9, clock + 1e9 + 1000, 10);
    // Nothing left claimable → it ended in a terminal 'failed' (dead-letter) state.
    expect(rows.length).toBe(0);
    // The in-app row was still written on the first attempt (feed precedes webhook).
    expect((await db.listNotificationFeed('tA', 'bob')).length).toBe(1);
  });

  it('reconcile backfills a terminal run that has a subscriber but no outbox row (crash backstop)', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'b@x.dev', name: 'Bob', passwordHash: 'x' });
    await makeRun(db, 'r1', 'completed');
    // Subscribe but DON'T enqueue (simulates a crash between terminal + enqueue).
    await createSqlSubscriptionManager(db).subscribe({ runId: 'r1', tenantId: 'tA', userId: 'bob' });
    expect(await db.hasNotificationOutboxForRun('r1')).toBe(false);

    const relay = createNotificationRelay({ db, webhookSender: async () => {} });
    await relay.reconcile();
    expect(await db.hasNotificationOutboxForRun('r1')).toBe(true);
    expect((await db.listNotificationFeed('tA', 'bob')).length).toBe(1); // delivered
  });

  it('a leased row stuck in sending is reclaimed after its lease expires (worker crash)', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'b@x.dev', name: 'Bob', passwordHash: 'x' });
    const run = await makeRun(db, 'r1', 'completed');
    await createSqlSubscriptionManager(db).subscribe({ runId: 'r1', tenantId: 'tA', userId: 'bob' });
    await enqueueRunTerminalNotifications(db, run, 1000);
    // Claim (lease) the row but never complete it — the "worker" crashed.
    const claimed = await db.claimNotificationOutbox(1000, 2000, 10);
    expect(claimed.length).toBe(1);
    // Before the lease expires, it is NOT reclaimable.
    expect((await db.claimNotificationOutbox(1500, 3000, 10)).length).toBe(0);
    // After the lease expires, a new worker reclaims it.
    expect((await db.claimNotificationOutbox(2500, 4000, 10)).length).toBe(1);
  });
});
