/**
 * Collaboration Phase 3 — durable, crash-safe run-notification delivery.
 *
 * This is the "transactional outbox" that makes "tell me when this run finishes,
 * even if I close the tab" RELIABLE across process restarts and crashes.
 *
 * --- For someone new to this ---
 * When a run finishes we must notify everyone who subscribed. But "the run
 * finished" (a DB write) and "the notification was sent" (a network call) are two
 * different actions — if the server crashes between them, a naive design loses the
 * notification. The OUTBOX pattern fixes that: the instant a run reaches a
 * terminal state we INSERT one durable "delivery job" row per subscriber. A
 * background RELAY then drains those rows — writing the in-app inbox entry and
 * firing webhooks — and only marks each job `sent` once delivery succeeds. If the
 * process dies mid-send, the job is still `pending`/`sending` in the database, so
 * after restart the relay simply picks it up again. Delivery is therefore
 * "at-least-once"; a stable idempotency key + the feed's dedupe collapses any
 * duplicate into one, giving "effectively once".
 *
 *   terminal run ──enqueue──▶ notification_outbox ──relay(lease)──▶ in-app feed
 *                                    │                          └──▶ signed webhook
 *                                    └─ crash-safe: survives restart, re-leased
 *
 * Components:
 *  - {@link enqueueRunTerminalNotifications} — fan-out-on-write at terminal time.
 *  - {@link createNotificationRelay} — the leased drain loop (+ a reconciler that
 *    backfills any terminal run whose outbox row was never written, e.g. a crash
 *    BETWEEN the terminal append and the enqueue).
 *
 * Security (mid-2026 research): webhooks are signed per the Standard Webhooks spec
 * (HMAC-SHA256 over `id.timestamp.body`, `webhook-id`/`webhook-timestamp`/
 * `webhook-signature` headers); outbound HTTP uses the SSRF-hardened fetch
 * (blocks private/link-local ranges + validates at dial time); payloads carry an
 * opaque `geneweave://run/<id>` deep link and never leak tenant/principal ids.
 */
import { createHardenedFetch, createLogger, newUUIDv7, type NotificationMessage } from '@weaveintel/core';
import { createHmac } from 'node:crypto';
import type { DatabaseAdapter } from './db-types.js';
import type { UserRunRow, NotificationOutboxRow } from './db-types/adapter-me.js';
import { createSqlFeedStore } from './run-subscription-sql.js';
import type { NotificationFeedStore } from '@weaveintel/notifications';

const logger = createLogger('run-notifications-outbox');
const GLOBAL_TENANT = '__global__';

/** Map a terminal run status to a notification title + priority. */
function terminalMessageFor(run: UserRunRow): { title: string; priority: 'normal' | 'high' } {
  switch (run.status) {
    case 'failed': return { title: 'Your run failed', priority: 'high' };
    case 'cancelled': return { title: 'Your run was cancelled', priority: 'normal' };
    default: return { title: 'Your run completed', priority: 'normal' };
  }
}

/**
 * Fan-out-on-write: enqueue one durable outbox row per subscriber the instant a
 * run reaches a terminal state. Idempotent — `UNIQUE(run_id, user_id)` on the
 * outbox means re-enqueueing (e.g. from the reconciler) is a no-op. Returns the
 * number of NEW rows enqueued.
 */
export async function enqueueRunTerminalNotifications(db: DatabaseAdapter, run: UserRunRow, now = Date.now()): Promise<number> {
  const subscribers = await db.listRunSubscribers(run.id);
  if (subscribers.length === 0) return 0;
  const { title, priority } = terminalMessageFor(run);
  let enqueued = 0;
  for (const sub of subscribers) {
    const tenantId = sub.tenant_id ?? run.tenant_id ?? null;
    // Stable per (run, user, status): a re-enqueue yields the same key, so the
    // in-app feed dedupes and the webhook keeps one webhook-id across retries.
    const idempotencyKey = `${run.id}:${sub.user_id}:${run.status}`;
    const msg: NotificationMessage = {
      id: idempotencyKey,
      tenantId: tenantId ?? GLOBAL_TENANT,
      principalId: sub.user_id,
      category: 'run',
      title,
      deepLink: `geneweave://run/${run.id}`, // opaque — no tenant/principal ids
      priority,
    };
    const created = await db.enqueueNotificationOutbox({
      id: newUUIDv7(),
      run_id: run.id,
      tenant_id: tenantId,
      user_id: sub.user_id,
      channels: sub.channels,
      payload: JSON.stringify(msg),
      idempotency_key: idempotencyKey,
      next_attempt_at: now,
      created_at: now,
    });
    if (created) enqueued++;
  }
  if (enqueued > 0) logger.info('enqueued run-terminal notifications', { runId: run.id, enqueued });
  return enqueued;
}

// ─── SSRF guard for user-supplied webhook URLs ──────────────────────────────────

/**
 * First-line SSRF check at REGISTRATION time: require https and reject obvious
 * private / loopback / link-local / cloud-metadata hosts. This is defense in
 * depth — the SSRF-hardened fetch validates again at DIAL time (after DNS
 * resolution), which is what actually defeats DNS-rebinding; this just rejects
 * the blatant cases early with a clear error.
 */
export function isSafeWebhookUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return false; // cloud metadata
  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  // IPv4 literal in private / loopback / link-local ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;          // link-local
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a >= 224) return false;                         // multicast / reserved
  }
  return true;
}

// ─── Webhook signing (Standard Webhooks spec) ───────────────────────────────────

export interface SignedWebhook {
  headers: Record<string, string>;
  body: string;
}

/** Build the Standard-Webhooks signed request for a payload + per-endpoint secret. */
export function signWebhook(msgId: string, timestampSec: number, body: string, secret: string): Record<string, string> {
  // Sign `${id}.${timestamp}.${body}` with HMAC-SHA256, base64 — `v1,<sig>`.
  const signed = `${msgId}.${timestampSec}.${body}`;
  const sig = createHmac('sha256', secret).update(signed).digest('base64');
  return {
    'Content-Type': 'application/json',
    'webhook-id': msgId,
    'webhook-timestamp': String(timestampSec),
    'webhook-signature': `v1,${sig}`,
  };
}

/** A pluggable webhook sender (injected so tests don't make real network calls). */
export type WebhookSender = (url: string, body: string, headers: Record<string, string>) => Promise<void>;

/** Default sender: the SSRF-hardened fetch (blocks private/link-local, dial-time validated). */
export function createHardenedWebhookSender(timeoutMs = 10_000): WebhookSender {
  // no-raw-fetch: allow (the `fetch` here is the hardened closure, not global fetch)
  const { fetch } = createHardenedFetch({ errorTag: 'run-notifications:webhook', timeoutMs });
  return async (url, body, headers) => {
    const resp = await fetch(url, { method: 'POST', headers, body, redirect: 'error' as RequestRedirect });
    if (!resp.ok) throw new Error(`webhook returned HTTP ${resp.status}`);
  };
}

// ─── Relay (leased drain loop + reconciler) ─────────────────────────────────────

export interface NotificationRelayOptions {
  db: DatabaseAdapter;
  /** In-app feed store (defaults to the SQL adapter over `notification_feed`). */
  feedStore?: NotificationFeedStore;
  /** Webhook sender (defaults to the SSRF-hardened fetch). */
  webhookSender?: WebhookSender;
  /** Clock — injectable for tests. */
  now?: () => number;
  /** Batch size per drain tick. */
  batchSize?: number;
}

export interface NotificationRelay {
  /** Drain one batch of due/leased-expired outbox rows. Returns rows processed. */
  drainOnce(): Promise<number>;
  /** Backfill outbox rows for terminal runs that have subscribers but no outbox row yet (crash backstop), then drain. */
  reconcile(): Promise<number>;
  /** Start the periodic drain loop. */
  start(): void;
  /** Stop the loop. */
  stop(): void;
}

interface RelayConfig {
  sweepMs: number;
  maxAttempts: number;
  leaseMs: number;
  baseBackoffMs: number;
}

async function loadRelayConfig(db: DatabaseAdapter): Promise<RelayConfig> {
  const cfg = await db.getCollaborationConfig().catch(() => null);
  const c = cfg as unknown as Record<string, number> | null;
  return {
    sweepMs: c?.['notify_relay_sweep_ms'] ?? 5000,
    maxAttempts: c?.['notify_max_attempts'] ?? 6,
    leaseMs: c?.['notify_lease_ms'] ?? 30_000,
    baseBackoffMs: c?.['notify_base_backoff_ms'] ?? 2000,
  };
}

/** Exponential backoff with full jitter (capped at 5 min). */
function backoffMs(base: number, attempts: number, jitter: () => number): number {
  const exp = Math.min(base * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
  return Math.floor(exp * (0.5 + 0.5 * jitter())); // 50–100% of the window
}

export function createNotificationRelay(opts: NotificationRelayOptions): NotificationRelay {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());
  const feedStore = opts.feedStore ?? createSqlFeedStore(db);
  const webhookSender = opts.webhookSender ?? createHardenedWebhookSender();
  const batchSize = opts.batchSize ?? 20;
  // Deterministic-enough jitter without Math.random (which is unavailable in some
  // sandboxes): derive from the wall clock. Collisions are harmless here.
  const jitter = () => (now() % 1000) / 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let draining = false;

  /** Deliver one outbox row across its channels. Throws to trigger a retry. */
  async function deliver(row: NotificationOutboxRow): Promise<void> {
    const msg = JSON.parse(row.payload) as NotificationMessage;
    const channels: string[] = (() => { try { return JSON.parse(row.channels) as string[]; } catch { return ['inapp']; } })();

    // 1. In-app feed — always written (it is the durable inbox record). Dedupe key
    //    = the outbox idempotency key, so a redelivery never doubles the row.
    await feedStore.append({
      id: newUUIDv7(),
      tenantId: msg.tenantId,
      principalId: msg.principalId,
      category: msg.category,
      title: msg.title,
      ...(msg.body ? { body: msg.body } : {}),
      ...(msg.deepLink ? { deepLink: msg.deepLink } : {}),
      priority: msg.priority ?? 'normal',
      createdAt: now(),
      readAt: null,
      dedupeKey: row.idempotency_key,
    });

    // 2. Webhooks — fire to each of the user's registered, SSRF-safe endpoints.
    if (channels.includes('webhook')) {
      const endpoints = await db.listWebhookEndpoints(row.user_id);
      const body = JSON.stringify({
        // CloudEvents-shaped envelope for interop.
        specversion: '1.0',
        id: row.idempotency_key,
        source: 'geneweave/runs',
        type: `run.${msg.title.toLowerCase().includes('fail') ? 'failed' : msg.title.toLowerCase().includes('cancel') ? 'cancelled' : 'completed'}`,
        time: new Date(now()).toISOString(),
        data: { category: msg.category, title: msg.title, deepLink: msg.deepLink, priority: msg.priority },
      });
      const tsSec = Math.floor(now() / 1000);
      for (const ep of endpoints) {
        const headers = signWebhook(row.idempotency_key, tsSec, body, ep.signing_secret);
        await webhookSender(ep.url, body, headers); // throws → whole row retried
      }
    }
  }

  async function drainOnce(): Promise<number> {
    const cfg = await loadRelayConfig(db);
    const claimed = await db.claimNotificationOutbox(now(), now() + cfg.leaseMs, batchSize);
    for (const row of claimed) {
      try {
        await deliver(row);
        await db.markNotificationOutboxSent(row.id, now());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = row.attempts >= cfg.maxAttempts; // attempts already incremented at claim
        const next = exhausted ? now() : now() + backoffMs(cfg.baseBackoffMs, row.attempts, jitter);
        await db.rescheduleNotificationOutbox(row.id, next, row.attempts, message, exhausted);
        if (exhausted) logger.warn('notification dead-lettered (retry budget exhausted)', { id: row.id, runId: row.run_id, err: message });
      }
    }
    return claimed.length;
  }

  async function reconcile(): Promise<number> {
    // Backstop: a crash BETWEEN the terminal append and the enqueue would leave a
    // terminal run with subscribers but no outbox row. Find recent terminal runs
    // that have subscribers but no outbox row and enqueue them.
    let backfilled = 0;
    try {
      const runs = await db.listTerminalRunsWithSubscribers(200);
      for (const run of runs) {
        if (await db.hasNotificationOutboxForRun(run.id)) continue;
        backfilled += await enqueueRunTerminalNotifications(db, run, now());
      }
    } catch (err) {
      logger.warn('reconcile scan failed (non-fatal)', { err: err instanceof Error ? err.message : String(err) });
    }
    await drainOnce();
    return backfilled;
  }

  async function tick(): Promise<void> {
    if (draining) return; // never overlap
    draining = true;
    try { while ((await drainOnce()) === batchSize) { /* keep draining a backlog */ } }
    catch (err) { logger.warn('relay tick failed', { err: err instanceof Error ? err.message : String(err) }); }
    finally { draining = false; }
  }

  return {
    drainOnce,
    reconcile,
    start() {
      if (timer) return;
      void loadRelayConfig(db).then((cfg) => {
        if (timer) return;
        timer = setInterval(() => { void tick(); }, Math.max(1000, cfg.sweepMs));
        if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      });
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
