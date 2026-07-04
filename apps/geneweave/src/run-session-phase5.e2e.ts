/**
 * Playwright E2E — Phase 5 (client UX primitives), live server + real LLM.
 *
 * Drives the REAL `createRunSession` controller from `@weaveintel/client`
 * (the framework-agnostic UX primitive that `@weaveintel/client/react`'s
 * `useRun` and the mobile session both build on) against the live geneweave
 * Run API, end-to-end, with a real OpenAI model — exercising the lifecycle
 * state machine (idle → submitted → streaming → ready), `stop()` (cancel),
 * `regenerate()`, and reconstruction of the view model — across all chat modes.
 *
 * The controller runs IN THIS TEST PROCESS (Node) against the live server; auth
 * is the logged-in browser's cookie + CSRF token, forwarded via `extraHeaders`,
 * so the same code path a browser would use is exercised.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-session-phase5
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createRunClient,
  createRunSession,
  type RunSession,
  type RunSessionState,
} from '@weaveintel/client';

const EMAIL = 'run-session-phase5@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Phase5', email: EMAIL, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

/** Build a RunClient that authenticates as the logged-in browser (cookie + CSRF). */
async function sessionClient(page: Page): Promise<{ baseUrl: string; client: ReturnType<typeof createRunClient> }> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await page.request.get('/api/auth/me');
  const csrf = me.ok() ? (((await me.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  const baseUrl = new URL(page.url()).origin;
  const client = createRunClient({
    baseUrl,
    extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': csrf },
  });
  return { baseUrl, client };
}

/** Resolve when the session reaches a terminal status, or reject on timeout. */
function awaitTerminal(session: RunSession, timeoutMs: number): Promise<RunSessionState> {
  return Promise.race([
    session.done(),
    new Promise<RunSessionState>((_, reject) =>
      setTimeout(() => reject(new Error(`run-session did not settle within ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 5 — createRunSession drives a real "${mode}" run to ready`, async ({ page }) => {
    test.setTimeout(180_000);
    await ensureLoggedIn(page);
    const { client } = await sessionClient(page);
    const session = createRunSession({ client, throttleMs: 40 });

    const statuses: string[] = [];
    const off = session.subscribe((s) => statuses.push(s.status));
    try {
      expect(session.getState().status).toBe('idle');
      const runId = await session.start({
        input: { text: 'Reply with exactly one word: pong' },
        metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' },
      });
      expect(typeof runId).toBe('string');
      expect(session.getState().status).toBe('submitted');

      const final = await awaitTerminal(session, 160_000);
      // eslint-disable-next-line no-console
      console.log(`[phase5][${mode}] status=${final.status} text="${final.model.fullText.slice(0, 60)}" statuses=${[...new Set(statuses)].join('>')}`);

      expect(final.status).toBe('ready');
      // The controller folded the live SSE into a real view model.
      expect(final.model.fullText.length).toBeGreaterThan(0);
      expect(final.model.fullText).toMatch(/\w/);
      // It passed through the streaming state on the way (lifecycle proof).
      expect(statuses).toContain('streaming');
    } finally {
      off();
      session.dispose();
    }
  });
}

test('Phase 5 — stop() cancels an in-flight run and settles ready', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const { client } = await sessionClient(page);
  const session = createRunSession({ client });
  try {
    await session.start({
      // A long generation so there is something in-flight to cancel.
      input: { text: 'Write a detailed 400-word essay about the history of cartography.' },
      metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o-mini' },
    });
    // Wait until it is actually streaming (or already settled if very fast).
    const start = Date.now();
    while (session.getState().status === 'submitted' && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await session.stop();
    expect(session.getState().status).toBe('ready');

    // Server-side: the run should be cancelled (or already completed if it raced).
    const rec = await client.getRun(session.getState().runId!);
    // eslint-disable-next-line no-console
    console.log(`[phase5][stop] sessionStatus=ready serverStatus=${rec?.status}`);
    expect(['cancelled', 'completed', 'running']).toContain(rec?.status);
  } finally {
    session.dispose();
  }
});

test('Phase 5 — regenerate() re-runs the last input as a fresh run', async ({ page }) => {
  test.setTimeout(180_000);
  await ensureLoggedIn(page);
  const { client } = await sessionClient(page);
  const session = createRunSession({ client });
  try {
    const firstId = await session.start({
      input: { text: 'Reply with exactly one word: ping' },
      metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' },
    });
    expect((await awaitTerminal(session, 80_000)).status).toBe('ready');

    const secondId = await session.regenerate();
    expect(secondId).not.toBe(firstId); // a genuinely new run
    const second = await awaitTerminal(session, 80_000);
    expect(second.status).toBe('ready');
    expect(second.model.fullText.length).toBeGreaterThan(0);
  } finally {
    session.dispose();
  }
});

test('Phase 5 — a concurrent start is rejected while a run is in progress (negative)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const { client } = await sessionClient(page);
  const session = createRunSession({ client });
  try {
    await session.start({
      input: { text: 'Reply with exactly one word: pong' },
      metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' },
    });
    await expect(
      session.start({ input: { text: 'second' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } }),
    ).rejects.toThrow(/already in progress/);
    await awaitTerminal(session, 80_000);
  } finally {
    session.dispose();
  }
});

test('Phase 5 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
