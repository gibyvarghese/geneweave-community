/**
 * Playwright E2E — Phase 6 (resumable streams · outbox v2 · observability),
 * live server + real LLM.
 *
 * Proves, end-to-end against the geneweave Run API with a real OpenAI model:
 *  1. REFRESH-PROOF RESUME — a session streams a run, the tab "closes"
 *     mid-stream (dispose, cursor persisted), a FRESH session re-attaches via
 *     `resume(runId)` (full journal replay) and drives it to `ready`, rebuilding
 *     the view model. Across direct/agent/supervisor/ensemble modes. The resume
 *     window is sourced from `GET /api/me/runs/config` (DB-driven).
 *  2. OBSERVABILITY — a completed run surfaces usage/cost on the view model
 *     (`vm.usage`) and folds into a `createRunMetrics` rollup.
 *  3. OUTBOX v2 — a run start enqueued while "offline" replays on flush and
 *     reaches a terminal state (offline compose → reconnect).
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-resume-phase6
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createRunClient,
  createRunSession,
  createRunCursorStore,
  createRunMetrics,
  createRunOutbox,
  MemoryStorage,
  type RunClient,
  type RunSession,
  type RunSessionState,
} from '@weaveintel/client';

const EMAIL = 'run-resume-phase6@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Phase6', email: EMAIL, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

interface Ctx { client: RunClient; resumeWindowMs: number }
async function ctx(page: Page): Promise<Ctx> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await page.request.get('/api/auth/me');
  const csrf = me.ok() ? (((await me.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  const baseUrl = new URL(page.url()).origin;
  const client = createRunClient({ baseUrl, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': csrf } });
  // DB-driven resume window, fetched the same way a host would.
  const cfg = await page.request.get('/api/me/runs/config');
  const resumeWindowSeconds = cfg.ok() ? (((await cfg.json()) as { resumeWindowSeconds?: number }).resumeWindowSeconds ?? 900) : 900;
  return { client, resumeWindowMs: resumeWindowSeconds * 1000 };
}

function awaitTerminal(session: RunSession, timeoutMs: number): Promise<RunSessionState> {
  return Promise.race([
    session.done(),
    new Promise<RunSessionState>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

/**
 * Resolve once the session has seen its first event (status → 'streaming',
 * which also means the cursor has been persisted), while the run is still live.
 * Not gated on text — supervisor/ensemble modes may emit text only at the end,
 * but they emit `run.started` early. Returns `true` if a resumable mid-run state
 * was reached, `false` if the run finished before we could observe one.
 */
async function waitForFirstEvent(session: RunSession, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = session.getState();
    if (s.status === 'streaming') return true;
    if (s.status === 'ready' || s.status === 'error') return false; // finished too fast to refresh
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not produce a first event in time');
}

async function pollServerTerminal(client: RunClient, runId: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rec = await client.getRun(runId);
    if (rec && ['completed', 'failed', 'cancelled'].includes(rec.status)) return rec.status;
    await new Promise((r) => setTimeout(r, 700));
  }
  return 'timeout';
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 6 — "${mode}" run survives a refresh: a fresh session resumes from cursor to ready`, async ({ page }) => {
    test.setTimeout(200_000);
    await ensureLoggedIn(page);
    const { client, resumeWindowMs } = await ctx(page);
    const storage = new MemoryStorage(); // shared across the "refresh" boundary

    // Session A — starts a longer run and streams, then the tab "closes".
    const a = createRunSession({ client, cursor: createRunCursorStore({ storage }), resumeWindowMs });
    let runId = '';
    let refreshable = false;
    try {
      runId = await a.start({
        input: { text: 'Write a vivid 250-word story about a lighthouse keeper and a storm.' },
        metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' },
      });
      refreshable = await waitForFirstEvent(a, 60_000);
    } finally {
      a.dispose(); // simulate refresh — cursor persists (no terminal reached here)
    }
    if (!refreshable) {
      test.skip(true, `${mode} run finished before a mid-run refresh could be observed`);
      return;
    }

    // The cursor for the in-flight run survived the "refresh".
    const survived = await createRunCursorStore({ storage }).get(runId);
    expect(survived?.runId).toBe(runId);

    // Session B (fresh tab) resumes from the same storage and rebuilds the model.
    const b = createRunSession({ client, cursor: createRunCursorStore({ storage }), resumeWindowMs });
    try {
      const resumedId = await b.resume(runId);
      expect(resumedId).toBe(runId);
      const final = await awaitTerminal(b, 160_000);
      // eslint-disable-next-line no-console
      console.log(`[phase6][${mode}] resumed status=${final.status} chars=${final.model.fullText.length}`);
      expect(final.status).toBe('ready');
      expect(final.model.fullText.length).toBeGreaterThan(0);
      // The cursor is cleared once the resumed run terminates.
      expect(await createRunCursorStore({ storage }).get(runId)).toBeNull();
    } finally {
      b.dispose();
    }
  });
}

test('Phase 6 — usage/cost surface on the view model and fold into a metrics rollup', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const { client } = await ctx(page);
  const metrics = createRunMetrics();
  const session = createRunSession({ client });
  try {
    await session.start({ input: { text: 'Reply with exactly one word: pong' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' } });
    const final = await awaitTerminal(session, 110_000);
    expect(final.status).toBe('ready');

    const usage = final.model.usage;
    // eslint-disable-next-line no-console
    console.log(`[phase6][usage] tokens=${usage?.totalTokens} cost=${usage?.costUsd} model=${usage?.model}`);
    expect(usage).toBeTruthy();
    expect((usage?.totalTokens ?? 0) + (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)).toBeGreaterThan(0);

    metrics.recordSession(final.status, final.model);
    const snap = metrics.snapshot();
    expect(snap.runs).toBe(1);
    expect(snap.completed).toBe(1);
    expect(snap.tokens.total).toBeGreaterThan(0);
  } finally {
    session.dispose();
  }
});

test('Phase 6 — Outbox v2: a start enqueued offline replays on flush and reaches terminal', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const { client } = await ctx(page);
  const outbox = createRunOutbox({ storage: new MemoryStorage() });

  // "Offline": enqueue without flushing.
  await outbox.enqueue({
    idempotencyKey: `phase6-outbox-${Date.now()}`,
    surface: 'web',
    input: { text: 'Reply with exactly one word: pong' },
    metadata: { mode: 'supervisor', provider: 'openai', model: 'gpt-4o-mini' },
  });
  expect(await outbox.pending()).toHaveLength(1);

  // "Reconnect": flush replays the buffered start against the live API.
  const res = await outbox.flush(client);
  // eslint-disable-next-line no-console
  console.log(`[phase6][outbox] flushed=${res.flushed} failed=${res.failed} dead=${res.deadLettered}`);
  expect(res.flushed).toBe(1);
  expect(await outbox.pending()).toHaveLength(0);

  // The replayed run actually exists and runs to terminal server-side.
  const runs = await client.listRuns({ limit: 5 });
  expect(runs.length).toBeGreaterThan(0);
  expect(['completed', 'failed']).toContain(await pollServerTerminal(client, runs[0]!.id, 110_000));
});

test('Phase 6 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
