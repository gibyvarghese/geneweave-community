/**
 * Playwright E2E — Client Phase 2 (typed parts[] + per-part state machine).
 *
 * Drives real runs through the live server and then feeds the persisted journal
 * through the REAL `@weaveintel/client` streamReducer, asserting the modern
 * `parts[]` model reconstructs correctly end-to-end (server → reducer):
 *   - a text part finalizes to `state:'done'`,
 *   - tool parts follow the lifecycle and never stay stuck `input-streaming`,
 *   - usage is present, parts are ordered/well-formed.
 * Run across every chat mode (direct/agent/supervisor/ensemble), plus a
 * REASONING model (OpenAI o4-mini) to exercise the reasoning part. UI smoke too.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-stream-phase2 -g "parts reconstruct|web UI"
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=o4-mini      npm run test:e2e -- run-stream-phase2 -g "reasoning model"
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { streamReducer, emptyRunViewModel, type RunViewModel, type ToolPart, type TextPart, type ReasoningPart } from '@weaveintel/client';

const EMAIL = 'run-stream-phase2@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Run Stream P2', email: EMAIL, password: PASSWORD } });
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
    await new Promise((res) => setTimeout(res, 600));
  }
  return 'timeout';
}
/** Feed the journal through the real client reducer → the modern parts view model. */
function reconstruct(journal: JournalEvent[]): RunViewModel {
  let vm = emptyRunViewModel();
  for (const e of journal) vm = streamReducer(vm, e);
  return vm;
}
async function startRun(page: Page, mode: string, text: string): Promise<string> {
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post('/api/me/runs', { headers, data: { surface: 'web', input: { text }, metadata: { mode } } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 2 — "${mode}" parts reconstruct from journal`, async ({ page }) => {
    test.setTimeout(150_000);
    await ensureLoggedIn(page);
    const runId = await startRun(page, mode, 'Use the calculator tool to compute 144 divided by 12, then reply with just the number.');
    const status = await pollTerminal(page.request, runId, 140_000);
    expect(['completed', 'failed']).toContain(status);

    const vm = reconstruct(await readJournal(page.request, runId));
    expect(vm.status).toBe(status);

    // Every tool part must reach a terminal state — none stuck mid-stream.
    const tools = vm.parts.filter((p): p is ToolPart => p.type === 'tool');
    for (const t of tools) {
      expect(['input-available', 'output-available', 'output-error']).toContain(t.state);
      expect(t.toolName.length).toBeGreaterThan(0);
      expect(t.toolCallId.length).toBeGreaterThan(0);
    }

    if (status === 'completed') {
      // A finalized text part with the answer.
      const texts = vm.parts.filter((p): p is TextPart => p.type === 'text');
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.every((t) => t.state === 'done')).toBe(true);
      // Usage reconstructed (Phase 1) and present in the model.
      expect(vm.usage?.model).toBeTruthy();
    }
    // eslint-disable-next-line no-console
    console.log(`[phase2][${mode}] status=${status} parts=${vm.parts.length} types=${[...new Set(vm.parts.map((p) => p.type))].join(',')} tools=${tools.length}`);
  });
}

test('Phase 2 — reasoning model surfaces reasoning parts', async ({ page }) => {
  test.setTimeout(180_000);
  await ensureLoggedIn(page);
  const runId = await startRun(page, 'agent', 'Think step by step, then give the final answer: if a train travels 60 km in 1.5 hours, what is its average speed in km/h?');
  const status = await pollTerminal(page.request, runId, 170_000);
  expect(['completed', 'failed']).toContain(status);

  const journal = await readJournal(page.request, runId);
  const vm = reconstruct(journal);
  const reasoningParts = vm.parts.filter((p): p is ReasoningPart => p.type === 'reasoning');
  const reasoningEvents = journal.filter((e) => e.kind === 'reasoning.delta').length;
  // eslint-disable-next-line no-console
  console.log(`[phase2][reasoning] status=${status} reasoning.delta=${reasoningEvents} reasoningParts=${reasoningParts.length} reasoningChars=${vm.reasoningText.length} model=${vm.usage?.model ?? '?'}`);

  // Usage always reconstructs; if the model emitted reasoning, the part is well-formed and finalized.
  if (status === 'completed') expect(vm.usage?.model).toBeTruthy();
  if (reasoningEvents > 0) {
    expect(reasoningParts.length).toBeGreaterThan(0);
    expect(reasoningParts.every((r) => r.state === 'done')).toBe(true);
    expect(vm.reasoningText.length).toBeGreaterThan(0);
    // Reasoning is a DISTINCT channel — never merged into the answer text.
    expect(vm.fullText).not.toContain(vm.reasoningText);
  }
});

test('Phase 2 — web UI streams a real assistant reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
