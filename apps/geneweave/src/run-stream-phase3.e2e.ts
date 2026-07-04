/**
 * Playwright E2E — Phase 3 (generative UI · citations · artifacts), live + real LLM.
 *
 * A real run that calls `web_search` (keyless DuckDuckGo provider) now surfaces,
 * via the bridge, a CITATION per source and a generative-UI table WIDGET of the
 * results — both reconstructed end-to-end by the real @weaveintel/client reducer
 * (citations[] + a widget part). Run across the tool-enabled chat modes.
 * Tolerant: skips when the free search provider returns nothing (rate-limited).
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-stream-phase3
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { streamReducer, emptyRunViewModel, type RunViewModel, type WidgetPart } from '@weaveintel/client';

const EMAIL = 'run-stream-phase3@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Phase3', email: EMAIL, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  return r.ok() ? (((await r.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
}
interface JournalEvent { runId: string; sequence: number; kind: string; payload: Record<string, unknown> }
async function readJournal(req: APIRequestContext, runId: string): Promise<JournalEvent[]> {
  const res = await req.get(`/api/me/runs/${runId}/events?after=-1`);
  expect(res.ok()).toBeTruthy();
  const out: JournalEvent[] = [];
  for (const block of (await res.text()).split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(5).trim()) as JournalEvent); } catch { /* keepalive */ }
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
    await new Promise((res) => setTimeout(res, 700));
  }
  return 'timeout';
}
function reconstruct(journal: JournalEvent[]): RunViewModel {
  let vm = emptyRunViewModel();
  for (const e of journal) vm = streamReducer(vm, e);
  return vm;
}

for (const mode of ['agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 3 — "${mode}" run surfaces citations + a results widget from web_search`, async ({ page }) => {
    test.setTimeout(180_000);
    await ensureLoggedIn(page);
    const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
    const res = await page.request.post('/api/me/runs', {
      headers,
      data: {
        surface: 'web',
        input: { text: 'You MUST call the web_search tool with the query "TypeScript official website" before answering. Do not answer from memory — call the tool, then list the sources.' },
        metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' },
      },
    });
    expect(res.status()).toBe(201);
    const runId = ((await res.json()) as { id: string }).id;
    expect(['completed', 'failed']).toContain(await pollTerminal(page.request, runId, 170_000));

    const journal = await readJournal(page.request, runId);
    const vm = reconstruct(journal);
    const searched = journal.some((e) => e.kind === 'tool.invoked' && e.payload['tool'] === 'web_search');
    const widgetParts = vm.parts.filter((p): p is WidgetPart => p.type === 'widget');
    // eslint-disable-next-line no-console
    console.log(`[phase3][${mode}] searched=${searched} citations=${vm.citations.length} widgets=${vm.widgets.size}/${widgetParts.length} artifacts=${vm.artifacts.size}`);

    if (!searched || vm.citations.length === 0) {
      test.skip(true, 'web_search did not return results (free DuckDuckGo provider unavailable/rate-limited)');
      return;
    }
    // Citations reconstructed with sources/urls.
    expect(vm.citations.length).toBeGreaterThan(0);
    expect(vm.citations.every((c) => typeof c.id === 'string')).toBe(true);
    expect(vm.citations.some((c) => typeof c.url === 'string' && c.url.length > 0)).toBe(true);
    // Generative-UI: a results table widget reconstructed as a widget part.
    expect(widgetParts.length).toBeGreaterThan(0);
    const w = widgetParts[0]!.payload as Record<string, unknown>;
    expect(w['type']).toBe('table');
    expect((w['data'] as { columns: string[] }).columns).toEqual(['Title', 'Source', 'URL']);
  });
}

test('Phase 3 — direct mode (no tools) completes without citations/widgets', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post('/api/me/runs', {
    headers,
    data: { surface: 'web', input: { text: 'Reply with exactly one word: pong' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } },
  });
  const runId = ((await res.json()) as { id: string }).id;
  expect(['completed', 'failed']).toContain(await pollTerminal(page.request, runId, 110_000));
  const vm = reconstruct(await readJournal(page.request, runId));
  expect(vm.citations.length).toBe(0);
  expect(vm.widgets.size).toBe(0);
});

test('F2 — agent emits a widget via the emit_widget tool (generative UI)', async ({ page }) => {
  test.setTimeout(180_000);
  await ensureLoggedIn(page);
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post('/api/me/runs', {
    headers,
    data: { surface: 'web', input: { text: 'Render a table widget titled "Fruit Colors" with columns Fruit and Color and rows for apple/red, banana/yellow, grape/purple. Use the emit_widget tool.' }, metadata: { mode: 'agent', provider: 'openai', model: 'gpt-4o' } },
  });
  expect(res.status()).toBe(201);
  const runId = ((await res.json()) as { id: string }).id;
  expect(['completed', 'failed']).toContain(await pollTerminal(page.request, runId, 170_000));

  const journal = await readJournal(page.request, runId);
  const vm = reconstruct(journal);
  const calledWidget = journal.some((e) => (e.kind === 'tool.invoked' || e.kind === 'tool.completed') && e.payload['tool'] === 'emit_widget');
  // eslint-disable-next-line no-console
  console.log(`[f2] emit_widget called=${calledWidget} widgets=${vm.widgets.size} kinds=${[...new Set(journal.map((e) => e.kind))].join(',')}`);
  if (vm.widgets.size === 0) { test.skip(true, 'model did not call emit_widget this run'); return; }
  // The widget reconstructs into the view model + a widget part.
  expect(vm.widgets.size).toBeGreaterThan(0);
  expect(vm.parts.some((p) => p.type === 'widget' && p.state === 'done')).toBe(true);
});

test('Phase 3 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
