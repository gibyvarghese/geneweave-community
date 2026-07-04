/**
 * Playwright E2E — Collaboration Phase 1 (presence), live server + real LLM.
 *
 * Proves end-to-end that presence ("who's watching this run") works over the
 * real Run API with a real OpenAI model:
 *  - a heartbeat makes a participant appear, surfaced live in `vm.presence` via
 *    the SSE `presence.update` broadcast AND returned by the heartbeat endpoint;
 *  - while the run is RUNNING the agent is shown as a first-class peer
 *    (human + agent → two participants);
 *  - an explicit leave removes the participant immediately;
 *  - presence is tenant/ownership-isolated — a different user gets 404;
 *  - the web UI still streams (regression).
 * Across direct / agent / supervisor / ensemble modes.
 *
 * NB: Phase 1 runs are single-owner, so genuine MULTI-USER presence on one run
 * arrives with Phase 2 (shared sessions). Here the "second participant" is the
 * agent peer, which exercises the full multi-participant snapshot mechanism. TTL
 * expiry + sweep are covered deterministically by the unit/contract tests.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-presence-phase1
 */
import { test, expect, type Page } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const EMAIL = 'run-presence-phase1@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const OTHER_EMAIL = 'run-presence-other@weaveintel.dev';

async function ensureLoggedIn(page: Page, email = EMAIL): Promise<void> {
  if (email === EMAIL && await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Presence', email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

async function makeClient(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await page.request.get('/api/auth/me');
  const csrf = me.ok() ? (((await me.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': csrf } });
}

function awaitTerminal(session: RunSession, timeoutMs: number): Promise<unknown> {
  return Promise.race([session.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 1 — "${mode}" run: heartbeat makes the user (and the agent) appear in presence, live`, async ({ page }) => {
    test.setTimeout(160_000);
    await ensureLoggedIn(page);
    const client = await makeClient(page);
    const session = createRunSession({ client });
    try {
      await session.start({
        // A longer prompt so the run is still STREAMING (session attached) while
        // we heartbeat — that's when the live presence.update broadcast lands.
        input: { text: 'Write a vivid 150-word paragraph about the sea at dawn.' },
        metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' },
      });
      const runId = session.getState().runId!;

      // Heartbeat repeatedly while the run streams; each heartbeat returns the
      // current snapshot AND broadcasts it over SSE. We stop as soon as the live
      // `vm.presence` reflects the human (proving the realtime path end-to-end).
      let humanInResponse = false;
      let liveHuman = false;
      for (let i = 0; i < 60; i++) {
        const snap = await client.setPresence(runId, { presence: 'online', displayName: 'Tester' });
        const parts = snap.participants as Array<{ userId: string; peerType: string; presence: string }>;
        humanInResponse = parts.some((p) => p.peerType === 'human' && p.presence === 'online');
        if (session.getState().model.presence.some((p) => p.peerType === 'human')) { liveHuman = true; break; }
        if (session.getState().status === 'ready' || session.getState().status === 'error') break;
        await sleep(250);
      }
      // eslint-disable-next-line no-console
      console.log(`[phase1][${mode}] humanInResponse=${humanInResponse} liveHuman=${liveHuman} vmPresence=${JSON.stringify(session.getState().model.presence.map((p) => p.userId))}`);
      expect(humanInResponse).toBe(true); // API: the human is present (server-derived identity)
      expect(liveHuman).toBe(true);       // live: the SSE presence.update reached vm.presence

      await awaitTerminal(session, 140_000);

      // Explicit leave → the human is removed immediately (no human participant left).
      const afterLeave = await client.setPresence(runId, { leave: true });
      const humansLeft = (afterLeave.participants as Array<{ peerType: string }>).filter((p) => p.peerType === 'human');
      expect(humansLeft.length).toBe(0);
    } finally {
      session.dispose();
    }
  });
}

test('Phase 1 — agent appears as a peer while the run is running', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const client = await makeClient(page);
  const session = createRunSession({ client });
  try {
    await session.start({ input: { text: 'Write a 200-word essay about clouds.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    const runId = session.getState().runId!;
    // Poll the presence endpoint while running — expect an agent peer to appear.
    let sawAgent = false;
    for (let i = 0; i < 40 && !sawAgent; i++) {
      const snap = await client.setPresence(runId, { presence: 'online' });
      sawAgent = (snap.participants as Array<{ peerType: string }>).some((p) => p.peerType === 'agent');
      if (session.getState().status !== 'streaming' && session.getState().status !== 'submitted') break;
      await sleep(150);
    }
    // eslint-disable-next-line no-console
    console.log(`[phase1][agent-peer] sawAgent=${sawAgent}`);
    await awaitTerminal(session, 100_000);
    // After completion, no agent peer (synthesized only while running).
    const finalSnap = await client.setPresence(runId, { presence: 'online' });
    expect((finalSnap.participants as Array<{ peerType: string }>).some((p) => p.peerType === 'agent')).toBe(false);
    expect(sawAgent).toBe(true); // it WAS a peer while running
  } finally {
    session.dispose();
  }
});

test('Phase 1 — presence is ownership/tenant isolated (a different user gets 404)', async ({ browser, page }) => {
  test.setTimeout(90_000);
  await ensureLoggedIn(page);
  const client = await makeClient(page);
  const session = createRunSession({ client });
  let runId = '';
  try {
    runId = await session.start({ input: { text: 'Reply with one word: pong' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
    await awaitTerminal(session, 80_000);
  } finally { session.dispose(); }

  // A SECOND user must not be able to read/write presence on the first user's run.
  const ctx = await browser.newContext();
  const otherPage = await ctx.newPage();
  await ensureLoggedIn(otherPage, OTHER_EMAIL);
  const csrf = ((await (await otherPage.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken ?? '';
  const res = await otherPage.request.post(`/api/me/runs/${runId}/presence`, { headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }, data: { presence: 'online' } });
  expect(res.status()).toBe(404); // not the owner → not found (no leak)
  await ctx.close();
});

test('Phase 1 — GET /api/me/collab/config serves the presence cadence', async ({ page }) => {
  await ensureLoggedIn(page);
  const res = await page.request.get('/api/me/collab/config');
  expect(res.status()).toBe(200);
  const cfg = await res.json() as { presenceHeartbeatMs: number; presenceTtlMs: number };
  expect(cfg.presenceHeartbeatMs).toBeGreaterThan(0);
  expect(cfg.presenceTtlMs).toBeGreaterThan(cfg.presenceHeartbeatMs); // TTL > heartbeat (anti-flicker)
});

test('Phase 1 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
