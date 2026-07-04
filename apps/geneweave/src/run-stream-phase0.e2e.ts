/**
 * Playwright E2E — Client Phase 0 (run/stream foundation), live server + real LLM.
 *
 * Proves the Phase 0 wiring end-to-end against the managed server:
 *   1. Run/stream config plumbing: GET /api/me/runs/config serves DB defaults;
 *      admin GET/PUT round-trips; hostile/out-of-range input is clamped and a
 *      malformed backoff array is rejected; a DB change is reflected at runtime.
 *   2. Real runs via POST /api/me/runs in every chat mode (direct / agent /
 *      supervisor / ensemble) using a REAL model (OpenAI gpt-4o-mini, no mock):
 *      each reaches a terminal state, the journal is gap-free (run.started … run.*),
 *      and a mid-cursor `?after=` resume returns only later events (no dupes).
 *   3. UI smoke: the web surface streams a real assistant reply.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-stream-phase0
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const EMAIL = 'run-stream-phase0@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';
const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000];

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Run Stream P0', email: EMAIL, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}

async function csrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

interface JournalEvent { sequence: number; kind: string; payload: Record<string, unknown> }

/** Read all SSE frames from a (terminal) run's events endpoint — it closes after replay. */
async function readJournal(req: APIRequestContext, runId: string, after = -1): Promise<JournalEvent[]> {
  const res = await req.get(`/api/me/runs/${runId}/events?after=${after}`);
  expect(res.ok()).toBeTruthy();
  const out: JournalEvent[] = [];
  for (const block of (await res.text()).split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(5).trim()) as JournalEvent); } catch { /* keepalive / partial */ }
  }
  return out;
}

async function pollTerminal(req: APIRequestContext, runId: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await req.get(`/api/me/runs/${runId}`);
    if (r.ok()) {
      const status = ((await r.json()) as { status: string }).status;
      if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  return 'timeout';
}

// ─── 1. Config plumbing (no LLM) ─────────────────────────────

test.describe('Phase 0 — run/stream config plumbing', () => {
  test('serves DB defaults, admin CRUD round-trips, clamps hostile input, reflects at runtime', async ({ page }) => {
    await ensureLoggedIn(page);
    const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

    // Served client config = seeded defaults.
    let cfg = await (await page.request.get('/api/me/runs/config')).json();
    expect(cfg.heartbeatMs).toBe(15000);
    expect(cfg.maxReconnects).toBe(8);
    expect(cfg.backoffMs).toEqual(DEFAULT_BACKOFF);
    // The retention/journal knobs must NOT leak to the client surface.
    expect(cfg).not.toHaveProperty('journalRetentionHours');

    // Admin GET returns the row.
    const adminGet = await page.request.get('/api/admin/run-stream-config');
    expect(adminGet.ok()).toBeTruthy();
    const row = (await adminGet.json())['run-stream-config'][0];
    expect(row.heartbeat_ms).toBe(15000);

    // PUT hostile / out-of-range values → clamped; malformed backoff → rejected (default kept).
    const put = await page.request.put('/api/admin/run-stream-config', {
      headers,
      data: { heartbeat_ms: 0, max_reconnects: 999, backoff_ms: 'garbage', throttle_ms: 200, journal_retention_hours: -5 },
    });
    expect(put.ok()).toBeTruthy();

    cfg = await (await page.request.get('/api/me/runs/config')).json();
    expect(cfg.heartbeatMs).toBe(1000);        // 0 clamped up to the floor
    expect(cfg.maxReconnects).toBe(100);       // 999 clamped down to the ceiling
    expect(cfg.throttleMs).toBe(200);          // applied
    expect(cfg.backoffMs).toEqual(DEFAULT_BACKOFF); // malformed string rejected → default retained

    // Restore defaults so the mode tests start clean.
    const restore = await page.request.put('/api/admin/run-stream-config', {
      headers,
      data: { heartbeat_ms: 15000, max_reconnects: 8, throttle_ms: 50, journal_retention_hours: 24, journal_max_events: 2000 },
    });
    expect(restore.ok()).toBeTruthy();
    cfg = await (await page.request.get('/api/me/runs/config')).json();
    expect(cfg.heartbeatMs).toBe(15000);
  });

  test('config + admin endpoints reject unauthenticated callers', async ({ playwright }) => {
    // A fresh context with no auth cookie.
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    expect((await anon.get('/api/me/runs/config')).status()).toBe(401);
    expect((await anon.get('/api/admin/run-stream-config')).status()).toBe(401);
    await anon.dispose();
  });
});

// ─── 2. Real runs across modes + journal resume ──────────────

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 0 — real run via /api/me/runs in "${mode}" mode: streams, journals, resumes`, async ({ page }) => {
    test.setTimeout(150_000);
    await ensureLoggedIn(page);
    const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

    const start = await page.request.post('/api/me/runs', {
      headers,
      data: { surface: 'web', input: { text: 'Reply with exactly one word: pong' }, metadata: { mode } },
    });
    expect(start.status()).toBe(201);
    const runId = ((await start.json()) as { id: string }).id;

    const status = await pollTerminal(page.request, runId, 140_000);
    expect(['completed', 'failed']).toContain(status); // reached a terminal state

    const journal = await readJournal(page.request, runId, -1);
    const kinds = journal.map((e) => e.kind);
    // Gap-free, monotonic sequence starting at run.started, ending terminal.
    expect(kinds[0]).toBe('run.started');
    expect(journal.map((e) => e.sequence)).toEqual(journal.map((_, i) => i));
    expect(kinds[kinds.length - 1]).toMatch(/^run\.(completed|failed|cancelled)$/);

    // Resume from a mid cursor → only later events, no duplicates, gap-free.
    if (journal.length > 2) {
      const mid = journal[1]!.sequence;
      const resumed = await readJournal(page.request, runId, mid);
      expect(resumed.every((e) => e.sequence > mid)).toBeTruthy();
      expect(resumed[0]!.sequence).toBe(mid + 1);
    }

    // direct/agent are deterministic enough to require a real completion + text on a real LLM.
    if (mode === 'direct' || mode === 'agent') {
      expect(status).toBe('completed');
      expect(kinds).toContain('text.delta');
    }
    // eslint-disable-next-line no-console
    console.log(`[phase0][${mode}] status=${status} events=${journal.length}`);
  });
}

// ─── 3. UI streaming smoke (real LLM) ────────────────────────

test('Phase 0 — web UI streams a real assistant reply', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  // Drive the composer programmatically (the UI exposes window.sendMessage).
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  const userMsg = page.locator('.msg.user').last();
  await expect(userMsg).toBeVisible({ timeout: 15000 });
  const assistant = page.locator('.msg.assistant .msg-body').last();
  await expect(assistant).toContainText(/\w/, { timeout: 90_000 }); // a real, non-empty streamed reply
});
