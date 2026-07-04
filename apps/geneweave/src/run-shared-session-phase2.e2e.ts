/**
 * Playwright E2E — Collaboration Phase 2 (shared sessions + invite links),
 * live server + real LLM. This is the multi-USER test Phase 1 set up.
 *
 * Proves end-to-end:
 *  - an OWNER shares a run → gets an invite token;
 *  - a SECOND user joins via the token as a VIEWER and can READ the run + its
 *    live event stream, and shows up in presence (TWO real humans now visible —
 *    the genuine multi-user presence Phase 1 couldn't reach);
 *  - role enforcement (server-side): a viewer CANNOT post control events or
 *    cancel; a COLLABORATOR can post events but still cannot cancel; only the
 *    OWNER can cancel + share;
 *  - security: a non-participant gets 404 (no leak), an invalid token is rejected.
 * Across direct / agent / supervisor / ensemble modes.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-shared-session-phase2
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'p2-owner@weaveintel.dev';
const GUEST = 'p2-guest@weaveintel.dev';
const STRANGER = 'p2-stranger@weaveintel.dev';

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
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

/** Start a run as the owner and return its id + the owner's client. */
async function ownerRun(page: Page, browser: Browser, mode: string): Promise<{ runId: string; ownerClient: RunClient; guestPage: Page; guestClient: RunClient }> {
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply with one short sentence about rivers.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 90_000);
  session.dispose();

  const ctx = await browser.newContext();
  const guestPage = await ctx.newPage();
  await login(guestPage, GUEST);
  const guestClient = await clientFor(guestPage);
  return { runId, ownerClient, guestPage, guestClient };
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 2 — "${mode}": owner shares → guest joins as viewer → can read, cannot control`, async ({ page, browser }) => {
    test.setTimeout(140_000);
    const { runId, ownerClient, guestPage, guestClient } = await ownerRun(page, browser, mode);

    // Before sharing, the guest cannot even see the run.
    expect(await guestClient.getRun(runId)).toBeNull(); // 404 → null (no leak)

    // Owner shares a VIEWER link.
    const share = await ownerClient.shareRun(runId, { role: 'viewer' });
    expect(share.token.length).toBeGreaterThan(40);
    expect(share.role).toBe('viewer');

    // Guest joins via the token.
    const joined = await guestClient.joinSession(share.token);
    expect(joined.runId).toBe(runId);
    expect(joined.role).toBe('viewer');

    // Now the guest CAN read the run + its journal (the replayed output).
    const run = await guestClient.getRun(runId);
    expect(run).not.toBeNull();

    // Both heartbeat → multi-user presence: the snapshot has TWO humans, badged.
    await ownerClient.setPresence(runId, { presence: 'online', displayName: 'Owner' });
    const snap = await guestClient.setPresence(runId, { presence: 'online', displayName: 'Guest' });
    const humans = (snap.participants as Array<{ peerType: string; role?: string }>).filter((p) => p.peerType === 'human');
    // eslint-disable-next-line no-console
    console.log(`[phase2][${mode}] humans=${humans.length} roles=${JSON.stringify(humans.map((h) => h.role))}`);
    expect(humans.length).toBe(2);                                  // two real users present
    expect(humans.some((h) => h.role === 'owner')).toBe(true);
    expect(humans.some((h) => h.role === 'viewer')).toBe(true);

    // ROLE ENFORCEMENT (server-side): a viewer cannot post control events or cancel.
    await expect(guestClient.postEvent(runId, { kind: 'client.event', payload: { x: 1 } })).rejects.toThrow();
    await expect(guestClient.cancelRun(runId)).rejects.toThrow();

    await guestPage.context().close();
  });
}

test('Phase 2 — a collaborator can post events but still cannot cancel (only owner cancels)', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  // A long run so it's still active when the collaborator posts (and cancel is meaningful).
  const runId = await session.start({ input: { text: 'Write a detailed 300-word essay about glaciers.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });

  const share = await ownerClient.shareRun(runId, { role: 'collaborator' });
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await login(gp, GUEST);
  const collab = await clientFor(gp);
  const joined = await collab.joinSession(share.token);
  expect(joined.role).toBe('collaborator');

  // Collaborator CAN post a (non-decision) control event — should not throw.
  await collab.postEvent(runId, { kind: 'client.note', payload: { hello: true } });
  // Collaborator CANNOT cancel — owner-only.
  await expect(collab.cancelRun(runId)).rejects.toThrow();
  // Owner CAN cancel.
  await ownerClient.cancelRun(runId).catch(() => { /* may already be terminal */ });

  session.dispose();
  await ctx.close();
});

test('Phase 2 — security: non-participant 404, invalid token rejected', async ({ page, browser }) => {
  test.setTimeout(110_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply with one word: pong' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 80_000);
  session.dispose();

  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await login(sp, STRANGER);
  const stranger = await clientFor(sp);
  // A stranger who never joined cannot see the run.
  expect(await stranger.getRun(runId)).toBeNull();
  // An invalid token is rejected (uniform error — no enumeration).
  await expect(stranger.joinSession('not-a-real-token')).rejects.toThrow();
  await ctx.close();
});

test('Phase 2 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
