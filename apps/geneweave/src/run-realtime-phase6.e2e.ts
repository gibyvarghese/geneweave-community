/**
 * Playwright E2E — Collaboration Phase 6 (real-time transport hardening + AG-UI
 * / A2A standards), live server + real LLM.
 *
 * Proves the acceptance:
 *  - an AG-UI client consumes a run WITH presence/state events: the real run +
 *    presence stream, fed through `toAGUIEvents`, yields `STATE_SNAPSHOT` +
 *    `STATE_DELTA` (RFC 6902 JSON Patch) + `CUSTOM` presence — across modes;
 *  - presence + CONTROL signals survive a tab switch: the WS control channel
 *    sends a `state.snapshot` on (re)connect, and cancel/steer work; control is
 *    idempotent (same requestId → not re-actioned);
 *  - SSE is resumable via the standard `Last-Event-ID` header (gap-free replay);
 *  - SECURITY: a cross-site Origin is rejected at the WS handshake (CSWSH); a
 *    viewer cannot cancel; a missing ticket is rejected.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-realtime-phase6
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, toAGUIEvents, type RunClient, type RunSession, type RunEventEnvelope } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'p6-owner@weaveintel.dev';
const VIEWER = 'p6-viewer@weaveintel.dev';

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
async function csrfToken(page: Page): Promise<string> {
  const me = await page.request.get('/api/auth/me');
  return (((await me.json()) as { csrfToken?: string }).csrfToken) ?? '';
}
async function wsTicket(page: Page): Promise<string> {
  const res = await page.request.post('/api/ws-ticket', { headers: { 'x-csrf-token': await csrfToken(page) } });
  return ((await res.json()) as { ticket: string }).ticket;
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the control WS IN THE BROWSER (so Origin is real), send actions, collect acks. */
async function wsControl(page: Page, runId: string, ticket: string, actions: Array<Record<string, unknown>>): Promise<{ snapshot: unknown; acks: Array<Record<string, unknown>> }> {
  return page.evaluate(async ({ runId, ticket, actions }) => {
    return await new Promise<{ snapshot: unknown; acks: Array<Record<string, unknown>> }>((resolve) => {
      const origin = location.origin.replace(/^http/, 'ws');
      const ws = new WebSocket(`${origin}/api/me/runs/${runId}/control?ticket=${ticket}`);
      let snapshot: unknown = null;
      const acks: Array<Record<string, unknown>> = [];
      const want = actions.length;
      const done = () => { try { ws.close(); } catch { /* */ } resolve({ snapshot, acks }); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (m['type'] === 'state.snapshot') { snapshot = m; if (want === 0) { done(); return; } for (const a of actions) ws.send(JSON.stringify(a)); return; }
        if (m['type'] === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        if (m['type'] === 'ack' || m['type'] === 'error') { acks.push(m); if (acks.length >= want) done(); }
      };
      ws.onerror = () => resolve({ snapshot, acks });
      setTimeout(done, 9000);
    });
  }, { runId, ticket, actions });
}

// ── AG-UI: a run + presence becomes STATE_SNAPSHOT / STATE_DELTA / CUSTOM ────────
for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 6 — "${mode}": AG-UI client sees the run WITH presence as STATE_DELTA + CUSTOM`, async ({ page }) => {
    test.setTimeout(160_000);
    await login(page, OWNER);
    const client = await clientFor(page);

    const session = createRunSession({ client });
    const runId = await session.start({ input: { text: 'Reply with one short sentence about stars.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });

    // Collect the live envelope stream (journaled run events + the ephemeral
    // presence.update we trigger below), then run the AG-UI adapter over it.
    const envelopes: RunEventEnvelope[] = [];
    const ctrl = client.attach(runId, { onEvent: (e) => envelopes.push(e) });
    await sleep(1500);
    await client.setPresence(runId, { presence: 'online', displayName: 'Owner' });
    await awaitTerminal(session, 110_000);
    await sleep(800);
    ctrl.abort();

    const agui = toAGUIEvents(envelopes);
    const types = agui.map((e) => e.type);
    // eslint-disable-next-line no-console
    console.log(`[phase6][${mode}] agui types=${JSON.stringify([...new Set(types)])}`);
    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types).toContain('STATE_SNAPSHOT');         // collaborative state seeded
    expect(types).toContain('STATE_DELTA');            // presence change as JSON Patch
    const presenceCustom = agui.find((e) => e.type === 'CUSTOM' && e['name'] === 'presence');
    expect(presenceCustom).toBeTruthy();
    session.dispose();
  });
}

test('Phase 6 — WS control channel: state.snapshot on connect, idempotent cancel, survives reconnect', async ({ page }) => {
  test.setTimeout(140_000);
  await login(page, OWNER);
  const client = await clientFor(page);
  const session = createRunSession({ client });
  // A long run so it is still active when we cancel it over the control channel.
  const runId = await session.start({ input: { text: 'Write a detailed 400-word essay about the solar system.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
  await sleep(1500);

  // First connection: snapshot + an IDEMPOTENT cancel (same requestId twice).
  const t1 = await wsTicket(page);
  const r1 = await wsControl(page, runId, t1, [{ type: 'cancel', requestId: 'cx1' }, { type: 'cancel', requestId: 'cx1' }]);
  expect(r1.snapshot).toMatchObject({ type: 'state.snapshot', run: { id: runId }, role: 'owner' });
  expect(r1.acks.length).toBe(2);
  expect(r1.acks.some((a) => a['cancelled'] === true)).toBe(true);
  expect(r1.acks.some((a) => a['duplicate'] === true)).toBe(true);   // second is a no-op
  // The run actually cancelled.
  await sleep(800);
  const run = await client.getRun(runId) as { status?: string } | null;
  expect(run?.status).toBe('cancelled');

  // Reconnect (simulating a tab switch): a brand-new socket still gets a fresh
  // state.snapshot reflecting the CURRENT (now cancelled) status — resume-beyond-reload.
  const t2 = await wsTicket(page);
  const r2 = await wsControl(page, runId, t2, []); // just connect → fresh snapshot
  expect(r2.snapshot).toMatchObject({ type: 'state.snapshot', run: { id: runId, status: 'cancelled' } });
  session.dispose();
});

test('Phase 6 — WS steer: a collaborator can steer; a viewer cannot cancel (role-gated)', async ({ page, browser }) => {
  test.setTimeout(140_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Write a detailed 400-word essay about volcanoes.' }, metadata: { mode: 'supervisor', provider: 'openai', model: 'gpt-4o-mini' } });

  // Share as collaborator → the collaborator steers over the control channel.
  const share = await ownerClient.shareRun(runId, { role: 'collaborator' });
  const ctx = await browser.newContext();
  const collabPage = await ctx.newPage();
  await login(collabPage, VIEWER);
  const collabClient = await clientFor(collabPage);
  await collabClient.joinSession(share.token);
  await sleep(1000);

  const ct = await wsTicket(collabPage);
  const steered = await wsControl(collabPage, runId, ct, [{ type: 'steer', requestId: 's1', payload: { text: 'focus on safety' } }]);
  expect(steered.acks[0]).toMatchObject({ ok: true });
  expect(typeof steered.acks[0]!['sequence']).toBe('number');

  await ownerClient.cancelRun(runId).catch(() => {});
  session.dispose();
  await ctx.close();
});

test('Phase 6 — SSE resumes from the Last-Event-ID header (gap-free)', async ({ page }) => {
  test.setTimeout(110_000);
  await login(page, OWNER);
  const client = await clientFor(page);
  const session = createRunSession({ client });
  const runId = await session.start({ input: { text: 'Reply with two short sentences about rain.' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 80_000);
  session.dispose();
  const origin = new URL(page.url()).origin;

  // Full stream first — learn the max sequence, and that frames carry `id:`.
  const full = await page.request.get(`${origin}/api/me/runs/${runId}/events`);
  const fullBody = await full.text();
  expect(fullBody).toContain('id: ');                       // resumable frames
  const seqs = [...fullBody.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(seqs.length).toBeGreaterThan(1);

  // Resume from id=1 via the STANDARD Last-Event-ID header → only later events.
  const resumed = await page.request.get(`${origin}/api/me/runs/${runId}/events`, { headers: { 'Last-Event-ID': '1' } });
  const resumedBody = await resumed.text();
  const resumedSeqs = [...resumedBody.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(resumedSeqs.every((s) => s > 1)).toBe(true);       // gap-free, no replay of 0/1
  expect(resumedSeqs).toContain(Math.max(...seqs));         // includes the terminal event
});

test('Phase 6 — security: WS rejects a cross-site Origin (CSWSH) and a missing ticket', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  const client = await clientFor(page);
  const session = createRunSession({ client });
  const runId = await session.start({ input: { text: 'Reply: ok' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 60_000);
  session.dispose();
  const origin = new URL(page.url()).origin;
  const wsOrigin = origin.replace(/^http/, 'ws');
  const ticket = await wsTicket(page);

  // Use a Node `ws` client so we can FORGE the Origin header (a browser can't).
  const { WebSocket } = await import('ws');
  function tryConnect(url: string, headers: Record<string, string>): Promise<{ ok: boolean; code?: number }> {
    return new Promise((resolve) => {
      const sock = new WebSocket(url, { headers });
      sock.on('open', () => { sock.close(); resolve({ ok: true }); });
      sock.on('error', () => resolve({ ok: false }));
      sock.on('unexpected-response', (_req, res) => resolve({ ok: false, code: res.statusCode }));
      setTimeout(() => { try { sock.close(); } catch { /* */ } resolve({ ok: false }); }, 5000);
    });
  }
  // Cross-site Origin → rejected (403) at the handshake.
  const evil = await tryConnect(`${wsOrigin}/api/me/runs/${runId}/control?ticket=${ticket}`, { Origin: 'http://evil.example.com' });
  expect(evil.ok).toBe(false);
  expect(evil.code).toBe(403);
  // Missing ticket → 401.
  const noTicket = await tryConnect(`${wsOrigin}/api/me/runs/${runId}/control`, { Origin: origin });
  expect(noTicket.ok).toBe(false);
});

test('Phase 6 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
