/**
 * Playwright E2E — Collaboration Phase 3 (durable subscriptions + offline
 * notifications) AND the CVE-2026-53843 force-disconnect, live server + real LLM.
 *
 * Proves end-to-end:
 *  - OFFLINE NOTIFY: a user subscribes to a run, does NOT keep a stream open
 *    ("closes the tab"), the run completes, and a durable in-app notification is
 *    delivered (feed row with the run deep link + unread badge) — restart-safe,
 *    via the transactional outbox. Across direct / agent / supervisor / ensemble.
 *  - LATE SUBSCRIBE: subscribing AFTER a run already finished still delivers
 *    (no lost-edge race).
 *  - CVE-2026-53843: an owner shares a viewer link, the guest joins and attaches
 *    a LIVE stream, the owner removes the member → the guest's live stream is
 *    FORCE-CLOSED with an `access.revoked` event (not left streaming).
 *  - SECURITY: the notification feed is strictly the caller's own; a non-owner
 *    cannot subscribe to a run they cannot access (404, no leak); the in-app row
 *    carries an opaque `geneweave://run/<id>` deep link (no tenant/principal id).
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-subscriptions-phase3
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession, type RunEventEnvelope } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const SUBSCRIBER = 'p3-sub@weaveintel.dev';
const OWNER = 'p3-owner@weaveintel.dev';
const GUEST = 'p3-guest@weaveintel.dev';
const STRANGER = 'p3-stranger@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await page.request.get('/api/auth/me');
  const csrf = me.ok() ? (((await me.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': csrf } });
}
async function userId(page: Page): Promise<string> {
  const me = await page.request.get('/api/auth/me');
  const body = (await me.json()) as { user?: { id?: string } };
  return body.user?.id ?? '';
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the in-app feed until a notification for `runId` arrives (or time out). */
async function waitForRunNotification(client: RunClient, runId: string, timeoutMs: number): Promise<{ deepLink?: string; category?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { items } = await client.listNotifications({ limit: 50 });
    const hit = (items as Array<{ deepLink?: string; category?: string }>).find((n) => n.deepLink === `geneweave://run/${runId}`);
    if (hit) return hit;
    await sleep(1500);
  }
  return null;
}

// ── Offline notification across all modes ───────────────────────────────────────
for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 3 — "${mode}": subscribe, close tab, run completes → durable in-app notification`, async ({ page }) => {
    test.setTimeout(160_000);
    await login(page, SUBSCRIBER);
    const client = await clientFor(page);

    // Start a run and immediately subscribe — then DROP the stream (close the tab).
    const session = createRunSession({ client });
    const runId = await session.start({ input: { text: 'Reply with one short sentence about mountains.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
    const sub = await client.subscribeRun(runId);
    expect(sub.channels).toContain('inapp');
    session.dispose(); // <-- "closes the tab": no live SSE stream attached anymore

    // The run completes server-side; a durable notification must arrive offline.
    const note = await waitForRunNotification(client, runId, 120_000);
    // eslint-disable-next-line no-console
    console.log(`[phase3][${mode}] notified runId=${runId} deepLink=${note?.deepLink}`);
    expect(note).not.toBeNull();
    expect(note?.category).toBe('run');
    expect(note?.deepLink).toBe(`geneweave://run/${runId}`); // opaque — no tenant/principal id

    // The unread badge reflects it; mark-all-read clears it.
    const { unreadCount } = await client.listNotifications({ unreadOnly: true });
    expect(unreadCount).toBeGreaterThan(0);
    const cleared = await client.markAllNotificationsRead();
    expect(cleared.read).toBeGreaterThan(0);
    expect((await client.listNotifications({ unreadOnly: true })).unreadCount).toBe(0);
  });
}

test('Phase 3 — late subscribe: subscribing AFTER a run finished still notifies (no lost edge)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, SUBSCRIBER);
  const client = await clientFor(page);
  const session = createRunSession({ client });
  const runId = await session.start({ input: { text: 'Reply with one word: done' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 80_000); // let it FULLY finish first
  session.dispose();

  // Only NOW subscribe — the endpoint enqueues immediately for an already-terminal run.
  await client.subscribeRun(runId);
  const note = await waitForRunNotification(client, runId, 60_000);
  expect(note).not.toBeNull();
});

test('Phase 3 / CVE-2026-53843 — removing a member force-closes their live stream', async ({ page, browser }) => {
  test.setTimeout(140_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  // A longer run so the guest's stream is still live when we remove them.
  const runId = await session.start({ input: { text: 'Write a detailed 250-word essay about the ocean.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });

  // Owner shares a viewer link; guest joins in a second browser context.
  const share = await ownerClient.shareRun(runId, { role: 'viewer' });
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await login(gp, GUEST);
  const guestClient = await clientFor(gp);
  const guestId = await userId(gp);
  const joined = await guestClient.joinSession(share.token);
  expect(joined.role).toBe('viewer');

  // Guest attaches a LIVE stream and records events (looking for access.revoked).
  const events: RunEventEnvelope[] = [];
  let revoked = false;
  const ctrl = guestClient.attach(runId, {
    onEvent: (e) => { events.push(e); if (e.kind === 'access.revoked') revoked = true; },
  });
  // Let the stream establish + confirm the guest can actually read it.
  await sleep(2500);
  expect(await guestClient.getRun(runId)).not.toBeNull();

  // Owner removes the guest → the guest's live stream must be force-closed.
  const removal = await ownerClient.removeMember(runId, guestId);
  expect(removal.removed).toBe(true);
  expect(removal.streamsClosed).toBeGreaterThanOrEqual(1);

  // The guest's stream receives access.revoked and stops (CVE remediation).
  const deadline = Date.now() + 15_000;
  while (!revoked && Date.now() < deadline) await sleep(500);
  expect(revoked).toBe(true);

  // And the guest no longer has access at all (404 on subsequent reads).
  expect(await guestClient.getRun(runId)).toBeNull();

  ctrl.abort();
  await ownerClient.cancelRun(runId).catch(() => {});
  session.dispose();
  await ctx.close();
});

test('Phase 3 — security: stranger cannot subscribe to a run they cannot access (404)', async ({ page, browser }) => {
  test.setTimeout(110_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply: ok' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 70_000);
  session.dispose();

  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await login(sp, STRANGER);
  const stranger = await clientFor(sp);
  await expect(stranger.subscribeRun(runId)).rejects.toThrow(); // 404 → throw (no leak)
  // The stranger's own feed is empty (strict per-principal isolation).
  expect((await stranger.listNotifications()).items.length).toBe(0);
  await ctx.close();
});

test('Phase 3 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, SUBSCRIBER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
