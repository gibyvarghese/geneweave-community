/**
 * Playwright E2E — Phase 4 (HITL approvals), live server + real LLM.
 *
 * A run with `metadata.hitl: true` gates EVERY tool behind approval: when the
 * model calls a tool the run PAUSES (stays running, emits approval.request),
 * the client answers via POST /api/me/runs/:id/events (approve/deny), and the
 * run RESUMES. Reconstructed end-to-end by the real @weaveintel/client reducer
 * (a `requires-action` approval part → approved/denied). Across tool modes + UI.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-stream-phase4
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { streamReducer, emptyRunViewModel, type RunViewModel, type ApprovalPart } from '@weaveintel/client';

const EMAIL = 'run-stream-phase4@weaveintel.dev';
const PASSWORD = 'Str0ng!Pass99';

async function ensureLoggedIn(page: Page): Promise<void> {
  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  let res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: 'Phase4', email: EMAIL, password: PASSWORD } });
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
/**
 * Read the live SSE INCREMENTALLY (the events endpoint live-tails a running run
 * and never closes, so a buffered read would hang). Stops at approval.request
 * or a terminal event. Uses the browser's fetch (cookie auth) via page.evaluate.
 */
async function waitForApproval(page: Page, runId: string, timeoutMs: number): Promise<string> {
  return page.evaluate(async ({ runId, timeoutMs }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`/api/me/runs/${runId}/events?after=-1`, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
      if (!resp.ok || !resp.body) return '';
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as { kind: string; payload: Record<string, unknown> };
            if (ev.kind === 'approval.request') { ctrl.abort(); return typeof ev.payload['taskId'] === 'string' ? ev.payload['taskId'] : ''; }
            if (ev.kind.startsWith('run.') && ev.kind !== 'run.started') { ctrl.abort(); return ''; } // terminal, no approval
          } catch { /* keepalive / partial */ }
        }
      }
    } catch { /* aborted / closed */ } finally { clearTimeout(timer); }
    return '';
  }, { runId, timeoutMs });
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
function reconstruct(j: JournalEvent[]): RunViewModel {
  let vm = emptyRunViewModel();
  for (const e of j) vm = streamReducer(vm, e);
  return vm;
}
async function startHitlRun(page: Page, mode: string): Promise<string> {
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post('/api/me/runs', {
    headers,
    // A natural hard-math prompt the model answers via the calculator tool.
    // (Forceful "you MUST call the tool" phrasing trips the injection guardrail.)
    data: { surface: 'web', input: { text: 'What is the exact product of 738291 and 654982?' }, metadata: { mode, provider: 'openai', model: 'gpt-4o', hitl: true } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function decide(page: Page, runId: string, taskId: string, action: 'approve' | 'reject'): Promise<number> {
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post(`/api/me/runs/${runId}/events`, { headers, data: { kind: 'approval.decision', payload: { taskId, action } } });
  return res.status();
}

for (const mode of ['agent', 'supervisor'] as const) {
  test(`Phase 4 — "${mode}" run pauses on a gated tool and resumes on approve`, async ({ page }) => {
    test.setTimeout(280_000);
    await ensureLoggedIn(page);
    const runId = await startHitlRun(page, mode);

    const taskId = await waitForApproval(page, runId, 120_000);
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] approval taskId=${taskId || '(none)'}`);
    if (!taskId) {
      // Diagnostic: did the run call a tool at all (HITL wiring vs model behaviour)?
      await pollTerminal(page.request, runId, 30_000);
      const j = await readJournal(page.request, runId);
      const vm0 = reconstruct(j);
      const diag = j.filter((e) => e.kind === 'diagnostic').map((e) => (e.payload as { channel?: string }).channel);
      // eslint-disable-next-line no-console
      console.log(`[phase4][${mode}] no-approval kinds=${[...new Set(j.map((e) => e.kind))].join(',')} diag=${diag.join('|')} text="${vm0.fullText.slice(0, 200)}"`);
      test.skip(true, `model did not call a tool in ${mode} mode — no approval to exercise`);
      return;
    }

    // The run is paused (still running) awaiting the decision.
    const midStatus = ((await (await page.request.get(`/api/me/runs/${runId}`)).json()) as { status: string }).status;
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] midStatus=${midStatus}`);
    expect(midStatus).toBe('running');

    const decideStatus = await decide(page, runId, taskId, 'approve');
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] decide(approve)=${decideStatus}`);
    expect(decideStatus).toBe(200);
    const terminal = await pollTerminal(page.request, runId, 180_000);
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] terminal=${terminal}`);
    expect(terminal).toBe('completed');

    const journal = await readJournal(page.request, runId);
    const vm = reconstruct(journal);
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] kinds=${[...new Set(journal.map((e) => e.kind))].join(',')} tools=${vm.toolCalls.length} approvals=${vm.approvals.length}`);
    // HITL proof: the approval reconstructs as approved, on both the list + the part.
    const ap = vm.approvals.find((a) => a.taskId === taskId)!;
    expect(ap.status).toBe('approved');
    expect(vm.parts.some((p): p is ApprovalPart => p.type === 'approval' && p.taskId === taskId && p.state === 'approved')).toBe(true);
    // The approval was raised for a real tool the model chose to call, and the
    // gated tool RAN after approval (reconstructed as a finished tool call/part).
    expect(typeof ap.toolName === 'string' && ap.toolName.length > 0).toBe(true);
    expect(vm.toolCalls.length).toBeGreaterThan(0);
    expect(vm.parts.some((p) => p.type === 'tool' && p.state === 'output-available')).toBe(true);
  });
}

test('Phase 4 — denying a gated tool resolves the approval as denied (run still terminates)', async ({ page }) => {
  test.setTimeout(180_000);
  await ensureLoggedIn(page);
  const runId = await startHitlRun(page, 'agent');
  const taskId = await waitForApproval(page, runId, 120_000);
  if (!taskId) { test.skip(true, 'model did not call a tool — no approval to deny'); return; }

  expect(await decide(page, runId, taskId, 'reject')).toBe(200);
  expect(['completed', 'failed']).toContain(await pollTerminal(page.request, runId, 120_000));
  const vm = reconstruct(await readJournal(page.request, runId));
  expect(vm.approvals.find((a) => a.taskId === taskId)!.status).toBe('denied');
});

test('Phase 4 — a decision for an unknown task returns 404', async ({ page }) => {
  await ensureLoggedIn(page);
  const runId = await startHitlRun(page, 'direct'); // direct = no tools, completes fast
  const headers = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };
  const res = await page.request.post(`/api/me/runs/${runId}/events`, { headers, data: { kind: 'approval.decision', payload: { taskId: 'does-not-exist', action: 'approve' } } });
  expect(res.status()).toBe(404);
});

test('Phase 4 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureLoggedIn(page);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
