/**
 * Playwright E2E — Collaboration Phase 7 (CRDT co-editing / agent-as-peer), live
 * server + real LLM. The optional frontier: a human and the AI agent co-edit ONE
 * document concurrently and converge.
 *
 * Proves the acceptance:
 *  - a human and the AGENT co-edit one doc concurrently → convergent merge: the
 *    human types via local CRDT ops while the agent (the run's real LLM output)
 *    is merged in as a peer; the server (trusted relay) converges them, and an
 *    independent client replica reconstructs the IDENTICAL text — across modes;
 *  - OFFLINE edits reconcile: a peer that edited while "disconnected" syncs via
 *    the state-vector diff (`opsSince`) and converges;
 *  - AWARENESS cursors broadcast live (ephemeral);
 *  - SECURITY: a forged author site is rejected (400/403); a viewer cannot edit
 *    (403); a non-participant gets 404.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-coedit-phase7
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';
import { RgaDoc, type RgaOp } from '@weaveintel/collab';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'p7-owner@weaveintel.dev';
const EDITOR = 'p7-editor@weaveintel.dev';
const STRANGER = 'p7-stranger@weaveintel.dev';

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

// ── Human + agent co-edit one doc concurrently → converge (across modes) ────────
for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 7 — "${mode}": human + agent co-edit one doc concurrently and CONVERGE`, async ({ page }) => {
    test.setTimeout(170_000);
    await login(page, OWNER);
    const client = await clientFor(page);

    // Start a real run that produces text (the agent's contribution to the doc).
    const session = createRunSession({ client });
    const runId = await session.start({ input: { text: 'Write two short sentences about the moon.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });

    // Create the co-edit doc and learn this user's server-derived site id.
    const ensured = await client.coeditEnsure(runId, { title: 'Moon notes' });
    expect(ensured.siteId).toMatch(/^u:/);

    // The HUMAN types a heading into a LOCAL CRDT replica and submits the ops —
    // concurrently with the agent's run producing its output.
    const human = new RgaDoc(ensured.siteId);
    const headingOps = human.localInsertText(0, '# Moon\n');
    const submitted = await client.coeditSubmitOps(runId, headingOps as unknown[]);
    expect(submitted.applied).toBe(headingOps.length);

    // Wait for the run to finish. The agent's output is merged into the doc as a
    // peer automatically on terminal; an explicit sync is idempotent (so `applied`
    // may be 0 if the auto-sync already ran — we assert on the final text instead).
    await awaitTerminal(session, 120_000);
    await client.coeditAgentSync(runId);

    // The doc now contains BOTH the human heading AND the agent's text, merged.
    const serverView = await client.coeditGet(runId);
    expect(serverView.text).toContain('# Moon');
    expect(serverView.text.length).toBeGreaterThan(15);   // the agent added real content beyond the heading

    // An INDEPENDENT replica (empty) reconciles via the state-vector diff and
    // reconstructs the IDENTICAL text — the convergence guarantee, end to end.
    const fresh = new RgaDoc('u:verifier');
    const { ops } = await client.coeditOpsSince(runId, fresh.stateVector());
    fresh.applyMany(ops as RgaOp[]);
    // eslint-disable-next-line no-console
    console.log(`[phase7][${mode}] converged len=${fresh.text().length} matches=${fresh.text() === serverView.text}`);
    expect(fresh.text()).toBe(serverView.text);           // CONVERGED
    expect(fresh.text()).toContain('# Moon');

    await client.cancelRun(runId).catch(() => {});
    session.dispose();
  });
}

test('Phase 7 — two humans + the agent: concurrent edits all converge through the relay', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Write one short sentence about tides.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
  const ensured = await ownerClient.coeditEnsure(runId);

  // Share as collaborator → a second human co-editor joins.
  const share = await ownerClient.shareRun(runId, { role: 'collaborator' });
  const ctx = await browser.newContext();
  const editorPage = await ctx.newPage();
  await login(editorPage, EDITOR);
  const editorClient = await clientFor(editorPage);
  await editorClient.joinSession(share.token);
  const editorView = await editorClient.coeditEnsure(runId);

  // Both humans edit CONCURRENTLY from their own replicas (different anchors).
  const owner = new RgaDoc(ensured.siteId);
  const ownerOps = owner.localInsertText(0, 'OWNER: ');
  await ownerClient.coeditSubmitOps(runId, ownerOps as unknown[]);

  const editor = new RgaDoc(editorView.siteId);
  const editorOps = editor.localInsertText(0, 'EDITOR: ');
  await editorClient.coeditSubmitOps(runId, editorOps as unknown[]);

  // The agent merges in too.
  await awaitTerminal(session, 100_000);
  await ownerClient.coeditAgentSync(runId);

  // Both clients fetch the full doc and see the SAME converged text.
  const ownerFull = await ownerClient.coeditGet(runId);
  const editorFull = await editorClient.coeditGet(runId);
  expect(ownerFull.text).toBe(editorFull.text);
  expect(ownerFull.text).toContain('OWNER:');
  expect(ownerFull.text).toContain('EDITOR:');

  await ownerClient.cancelRun(runId).catch(() => {});
  session.dispose();
  await ctx.close();
});

test('Phase 7 — offline reconcile + awareness broadcast', async ({ page }) => {
  test.setTimeout(110_000);
  await login(page, OWNER);
  const client = await clientFor(page);
  const session = createRunSession({ client });
  const runId = await session.start({ input: { text: 'Reply: ok' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 60_000);
  session.dispose();
  const ensured = await client.coeditEnsure(runId);

  // Build a base, then a SECOND device edits OFFLINE and reconciles.
  const base = new RgaDoc(ensured.siteId);
  await client.coeditSubmitOps(runId, base.localInsertText(0, 'base') as unknown[]);

  // A SECOND device of the same user gets its own distinct site (the server mints
  // a unique site per request under the user's namespace).
  const device2 = await client.coeditGet(runId);
  const offline = new RgaDoc(device2.siteId);
  const sync1 = await client.coeditOpsSince(runId, offline.stateVector());
  offline.applyMany(sync1.ops as RgaOp[]);               // catch up to "base"
  expect(offline.text()).toBe('base');
  const offlineOps = offline.localInsertText(4, '!');     // edit while "offline"
  await client.coeditSubmitOps(runId, offlineOps as unknown[]); // push on reconnect
  const view = await client.coeditGet(runId);
  expect(view.text).toBe('base!');

  // Awareness (cursor) broadcasts without error (ephemeral).
  const aware = await client.coeditAwareness(runId, { clock: 1, state: { name: 'Owner', color: '#6c63ff', status: 'editing', cursor: { anchorId: null, assoc: -1 } } });
  expect(aware.ok).toBe(true);
});

test('Phase 7 — security: forged site rejected; viewer cannot edit; stranger 404', async ({ page, browser }) => {
  test.setTimeout(110_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply: ok' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 60_000);
  session.dispose();
  await ownerClient.coeditEnsure(runId);

  // Forged author site (claiming someone else's id) → rejected.
  const forged = [{ type: 'ins', id: { counter: 1, siteId: 'u:somebody-else' }, originId: null, value: 'x' }];
  await expect(ownerClient.coeditSubmitOps(runId, forged)).rejects.toThrow();

  // A VIEWER cannot edit (403).
  const share = await ownerClient.shareRun(runId, { role: 'viewer' });
  const ctx = await browser.newContext();
  const vp = await ctx.newPage();
  await login(vp, EDITOR);
  const viewer = await clientFor(vp);
  await viewer.joinSession(share.token);
  const vView = await viewer.coeditEnsure(runId);
  const vDoc = new RgaDoc(vView.siteId);
  await expect(viewer.coeditSubmitOps(runId, vDoc.localInsertText(0, 'hax') as unknown[])).rejects.toThrow();

  // A non-participant gets 404 (no leak) — coeditGet returns the client default on 404.
  const sp = await (await browser.newContext()).newPage();
  await login(sp, STRANGER);
  const stranger = await clientFor(sp);
  expect((await stranger.coeditGet(runId)).docId).toBe('');

  await ctx.close();
});

test('Phase 7 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
