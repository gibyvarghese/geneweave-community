/**
 * Playwright E2E — Collaboration Phase 5 (unified handoff), live server + real LLM.
 *
 * Proves end-to-end the acceptance: an agent run ESCALATES to a human who ACCEPTS,
 * TAKES OVER the session, and HANDS BACK — full context + audit trail persisted;
 * a rejected handoff records its reason. Across direct / agent / supervisor / ensemble.
 *
 *  - OWNER requests an `agent_to_human` handoff to a REVIEWER (with a scoped
 *    briefing auto-built from the run); the reviewer is notified + sees it in their
 *    inbox, but has NO run access yet.
 *  - Reviewer ACCEPTS → is granted collaborator access ("takes over": can now read
 *    the run + comment) → STARTS (in_progress) → HANDS BACK with a briefing →
 *    OWNER COMPLETES. The append-only AUDIT trail records every transition.
 *  - REJECT records a required reason (and is audited).
 *  - SECURITY: a stranger cannot accept someone else's handoff (403); cannot
 *    request a handoff on a run they cannot see (404); a reason is required.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-handoff-phase5
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'p5-owner@weaveintel.dev';
const REVIEWER = 'p5-reviewer@weaveintel.dev';
const STRANGER = 'p5-stranger@weaveintel.dev';

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
async function userId(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/auth/me')).json()) as { user?: { id?: string } };
  return body.user?.id ?? '';
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

type H = { id: string; state: string; rejectionReason: string | null; toActor: { id: string }; briefing?: { summary?: string } };

/** Owner runs + finishes a run; returns owner client + a logged-in reviewer (id + client + page). */
async function ownerRunWithReviewer(page: Page, browser: Browser, mode: string): Promise<{ runId: string; ownerClient: RunClient; reviewerClient: RunClient; reviewerId: string; reviewerPage: Page }> {
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply with one short sentence about clouds.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 120_000);
  session.dispose();

  const ctx = await browser.newContext();
  const reviewerPage = await ctx.newPage();
  await login(reviewerPage, REVIEWER);
  const reviewerClient = await clientFor(reviewerPage);
  const reviewerId = await userId(reviewerPage);
  return { runId, ownerClient, reviewerClient, reviewerId, reviewerPage };
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 5 — "${mode}": escalate → accept → take over → hand back → complete (audited)`, async ({ page, browser }) => {
    test.setTimeout(200_000);
    const { runId, ownerClient, reviewerClient, reviewerId, reviewerPage } = await ownerRunWithReviewer(page, browser, mode);

    // Before any handoff, the reviewer cannot see the run.
    expect(await reviewerClient.getRun(runId)).toBeNull();

    // Owner ESCALATES to the reviewer (agent_to_human), with an auto-built briefing.
    const req = await ownerClient.requestHandoff(runId, { toUserId: reviewerId, scope: 'agent_to_human', reason: 'needs a human to confirm the policy' }) as { handoff: H };
    expect(req.handoff.state).toBe('requested');
    expect(req.handoff.briefing?.summary).toBeTruthy();           // context transferred
    const hid = req.handoff.id;

    // Reviewer sees it in their INBOX (even without run access yet) + was notified.
    const inbox = await reviewerClient.handoffInbox() as { handoffs: H[] };
    expect(inbox.handoffs.some((h) => h.id === hid)).toBe(true);
    const notes = await reviewerClient.listNotifications({ limit: 50 });
    expect((notes.items as Array<{ category?: string }>).some((n) => n.category === 'handoff')).toBe(true);

    // ACCEPT → the reviewer TAKES OVER (now has collaborator access to the run).
    const accepted = await reviewerClient.handoffAction(runId, hid, 'accept') as { handoff: H };
    expect(accepted.handoff.state).toBe('accepted');
    expect(await reviewerClient.getRun(runId)).not.toBeNull();    // access granted on accept
    // Taking over means they can act on the session (post a collaborator comment).
    await reviewerClient.addComment(runId, { body: 'Took over — confirming the policy.', anchor: { partId: 'text-1', createdAtSeq: 1 } });

    // START → HAND BACK (with a back-briefing) → OWNER COMPLETES.
    await reviewerClient.handoffAction(runId, hid, 'start');
    const back = await reviewerClient.handoffAction(runId, hid, 'hand-back', { briefing: { summary: 'Confirmed: policy allows it.' } }) as { handoff: H };
    expect(back.handoff.state).toBe('handed_back');
    const done = await ownerClient.handoffAction(runId, hid, 'complete') as { handoff: H };
    expect(done.handoff.state).toBe('completed');

    // The append-only AUDIT trail recorded every transition, in order.
    const audit = await ownerClient.handoffAudit(runId, hid) as { audit: Array<{ toState: string; actorId: string }> };
    // eslint-disable-next-line no-console
    console.log(`[phase5][${mode}] audit=${JSON.stringify(audit.audit.map((e) => e.toState))}`);
    expect(audit.audit.map((e) => e.toState)).toEqual(['requested', 'accepted', 'in_progress', 'handed_back', 'completed']);

    await reviewerPage.context().close();
  });
}

test('Phase 5 — a rejected handoff records its reason (audited)', async ({ page, browser }) => {
  test.setTimeout(160_000);
  const { runId, ownerClient, reviewerClient, reviewerId, reviewerPage } = await ownerRunWithReviewer(page, browser, 'agent');
  const req = await ownerClient.requestHandoff(runId, { toUserId: reviewerId, reason: 'cover this please' }) as { handoff: H };
  // A reject requires a reason.
  await expect(reviewerClient.handoffAction(runId, req.handoff.id, 'reject', {})).rejects.toThrow();
  const rejected = await reviewerClient.handoffAction(runId, req.handoff.id, 'reject', { reason: 'out of my area' }) as { handoff: H };
  expect(rejected.handoff.state).toBe('rejected');
  expect(rejected.handoff.rejectionReason).toBe('out of my area');
  const audit = await ownerClient.handoffAudit(runId, req.handoff.id) as { audit: Array<{ toState: string; note: string | null }> };
  expect(audit.audit.at(-1)?.toState).toBe('rejected');
  expect(audit.audit.at(-1)?.note).toBe('out of my area');
  await reviewerPage.context().close();
});

test('Phase 5 — security: stranger cannot accept someone else handoff, nor hand off a run they cannot see', async ({ page, browser }) => {
  test.setTimeout(160_000);
  const { runId, ownerClient, reviewerId, reviewerPage } = await ownerRunWithReviewer(page, browser, 'direct');
  const req = await ownerClient.requestHandoff(runId, { toUserId: reviewerId, reason: 'please take this' }) as { handoff: H };

  // A stranger (not the recipient) cannot accept the handoff (403 → throws).
  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await login(sp, STRANGER);
  const stranger = await clientFor(sp);
  await expect(stranger.handoffAction(runId, req.handoff.id, 'accept')).rejects.toThrow();
  // …and cannot request a handoff on a run they cannot see (404 → throws).
  await expect(stranger.requestHandoff(runId, { toUserId: reviewerId, reason: 'x' })).rejects.toThrow();
  // A reason is required to request.
  await expect(ownerClient.requestHandoff(runId, { toUserId: reviewerId, reason: '' })).rejects.toThrow();

  await ctx.close();
  await reviewerPage.context().close();
});

test('Phase 5 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
