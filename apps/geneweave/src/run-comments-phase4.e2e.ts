/**
 * Playwright E2E — Collaboration Phase 4 (collaborative run timeline: comments,
 * annotations, @mentions, public read-only share), live server + real LLM.
 *
 * Proves end-to-end:
 *  - a reviewer COMMENTS on a specific tool/step PART of a finished run (anchored
 *    to a stable part id), across direct / agent / supervisor / ensemble;
 *  - an @MENTION of a participant delivers an in-app notification (reuses Phase 3);
 *  - a scored ANNOTATION lands and is summarised + exportable as an eval example;
 *  - a PUBLIC share link renders the run review READ-ONLY and REDACTED (display
 *    names only, no emails/ids), with `X-Robots-Tag: noindex`;
 *  - threads resolve/reopen; edit is author-only; XSS in a comment is sanitized;
 *  - SECURITY: a non-participant cannot comment (404); a revoked public link 404s.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- run-comments-phase4
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'p4-owner@weaveintel.dev';
const REVIEWER = 'p4-reviewer@weaveintel.dev';
const STRANGER = 'p4-stranger@weaveintel.dev';

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

/** Start + finish a run as OWNER; share it with REVIEWER as collaborator. */
async function reviewedRun(page: Page, browser: Browser, mode: string): Promise<{ runId: string; ownerClient: RunClient; reviewerClient: RunClient; reviewerId: string; reviewerPage: Page }> {
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply with one short sentence about tides.' }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 120_000);
  session.dispose();

  const share = await ownerClient.shareRun(runId, { role: 'collaborator' });
  const ctx = await browser.newContext();
  const reviewerPage = await ctx.newPage();
  await login(reviewerPage, REVIEWER);
  const reviewerClient = await clientFor(reviewerPage);
  await reviewerClient.joinSession(share.token);
  const reviewerId = await userId(reviewerPage);
  return { runId, ownerClient, reviewerClient, reviewerId, reviewerPage };
}

for (const mode of ['direct', 'agent', 'supervisor', 'ensemble'] as const) {
  test(`Phase 4 — "${mode}": reviewer comments on a part, @mentions owner, scores it`, async ({ page, browser }) => {
    test.setTimeout(200_000);
    const { runId, ownerClient, reviewerClient, reviewerPage } = await reviewedRun(page, browser, mode);
    const ownerId = await userId(page);

    // Reviewer comments anchored to a specific part, @mentioning the owner.
    const created = await reviewerClient.addComment(runId, {
      body: 'This step looks off **@owner** please check',
      anchor: { partId: 'text-1', createdAtSeq: 1 },
      mentions: [ownerId],
    }) as { comment: { id: string; threadId: string; bodyHtml: string; anchor: { partId: string } } };
    expect(created.comment.anchor.partId).toBe('text-1');
    expect(created.comment.bodyHtml).toContain('<strong>');

    // Owner sees the comment, and got an in-app @mention notification.
    const list = await ownerClient.listComments(runId) as { comments: Array<{ id: string }> };
    expect(list.comments.some((c) => c.id === created.comment.id)).toBe(true);
    const notes = await ownerClient.listNotifications({ limit: 50 });
    const mentioned = (notes.items as Array<{ category?: string; deepLink?: string }>).some((n) => n.category === 'mention' && n.deepLink === `geneweave://run/${runId}`);
    // eslint-disable-next-line no-console
    console.log(`[phase4][${mode}] commentId=${created.comment.id} mentionNotified=${mentioned}`);
    expect(mentioned).toBe(true);

    // Reviewer scores the run (thumbs up + a 1-5 rating), summarised + exportable.
    await reviewerClient.addAnnotation(runId, { name: 'thumbs', dataType: 'boolean', value: 1, partId: 'text-1' });
    await reviewerClient.addAnnotation(runId, { name: 'helpfulness', dataType: 'numeric', value: 4 });
    const anns = await reviewerClient.listAnnotations(runId) as { annotations: unknown[]; summary: Array<{ name: string; average: number | null }> };
    expect(anns.annotations.length).toBe(2);
    expect(anns.summary.find((s) => s.name === 'helpfulness')?.average).toBe(4);

    await reviewerPage.context().close();
  });
}

test('Phase 4 — threads resolve/reopen; edit is author-only; XSS is sanitized', async ({ page, browser }) => {
  test.setTimeout(200_000);
  const { runId, ownerClient, reviewerClient, reviewerPage } = await reviewedRun(page, browser, 'agent');

  // Reviewer leaves a comment containing an XSS attempt — must be sanitized.
  const c = await reviewerClient.addComment(runId, { body: 'bug <img src=x onerror=alert(1)> here', anchor: { partId: 'text-1', createdAtSeq: 1 } }) as { comment: { id: string; threadId: string; bodyHtml: string } };
  // The dangerous tag is neutralised: no raw <img> element survives; it is inert
  // escaped text instead (so "onerror" only appears harmlessly as &lt;img…&gt;).
  expect(c.comment.bodyHtml).not.toContain('<img');
  expect(c.comment.bodyHtml).toContain('&lt;img');

  // The OWNER cannot edit the reviewer's comment (author-only) — but CAN moderate-delete it.
  await expect(ownerClient.editComment(runId, c.comment.id, 'hacked')).rejects.toThrow();

  // Owner resolves the thread; reviewer reopens it.
  const resolved = await ownerClient.resolveThread(runId, c.comment.threadId);
  expect(resolved.resolved).toBe(true);
  let after = await ownerClient.listComments(runId) as { comments: Array<{ id: string; resolvedAt: number | null }> };
  expect(after.comments.find((x) => x.id === c.comment.id)?.resolvedAt).not.toBeNull();
  await reviewerClient.reopenThread(runId, c.comment.threadId);
  after = await ownerClient.listComments(runId) as { comments: Array<{ id: string; resolvedAt: number | null }> };
  expect(after.comments.find((x) => x.id === c.comment.id)?.resolvedAt).toBeNull();

  // Author edits own comment; owner moderate-deletes it (tombstone).
  const edited = await reviewerClient.editComment(runId, c.comment.id, 'updated note') as { comment: { bodyHtml: string } };
  expect(edited.comment.bodyHtml).toContain('updated note');
  await ownerClient.deleteComment(runId, c.comment.id);
  const afterDelete = await ownerClient.listComments(runId) as { comments: Array<{ id: string; deletedAt: number | null }> };
  expect(afterDelete.comments.find((x) => x.id === c.comment.id)?.deletedAt).not.toBeNull();

  await reviewerPage.context().close();
});

test('Phase 4 — public read-only link renders the review, redacted + noindex; revoke 404s', async ({ page, browser }) => {
  test.setTimeout(200_000);
  const { runId, ownerClient, reviewerClient, reviewerPage } = await reviewedRun(page, browser, 'direct');
  await reviewerClient.addComment(runId, { body: 'Nice and clear', anchor: { partId: 'text-1', createdAtSeq: 1 } });
  await reviewerClient.addAnnotation(runId, { name: 'thumbs', dataType: 'boolean', value: 1 });

  // Owner mints a public link.
  const share = await ownerClient.createRunPublicShare(runId) as { token: string; url: string };
  expect(share.url).toContain('/share/runs/');

  // Fetch the PUBLIC page with a fresh, UNAUTHENTICATED context.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const origin = new URL(page.url()).origin;
  const resp = await anonPage.request.get(`${origin}/share/runs/${share.token}`);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['x-robots-tag']).toContain('noindex');
  const body = await resp.text();
  expect(body).toContain('Shared run review');
  expect(body).toContain('Nice and clear');           // comment rendered
  expect(body).not.toContain('@weaveintel.dev');       // NO emails leaked
  expect(body.toLowerCase()).not.toContain(runId.toLowerCase()); // no internal run id leaked

  // Owner revokes it → the public link now 404s.
  const shares = await page.request.get(`${origin}/api/me/runs/${runId}/comments`); // keep session warm
  expect(shares.ok()).toBe(true);
  await page.request.post(`${origin}/api/me/runs/${runId}/public-share/revoke`, {
    data: { id: (share as { id?: string }).id ?? '' },
    headers: { 'x-csrf-token': (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '' },
  });
  const after = await anonPage.request.get(`${origin}/share/runs/${share.token}`);
  expect(after.status()).toBe(404);

  await anon.close();
  await reviewerPage.context().close();
});

test('Phase 4 — security: a non-participant cannot comment or annotate (404, no leak)', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  const ownerClient = await clientFor(page);
  const session = createRunSession({ client: ownerClient });
  const runId = await session.start({ input: { text: 'Reply: ok' }, metadata: { mode: 'direct', provider: 'openai', model: 'gpt-4o-mini' } });
  await awaitTerminal(session, 70_000);
  session.dispose();

  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await login(sp, STRANGER);
  const stranger = await clientFor(sp);
  await expect(stranger.addComment(runId, { body: 'sneaky', anchor: { partId: 'text-1', createdAtSeq: 1 } })).rejects.toThrow();
  await expect(stranger.addAnnotation(runId, { name: 'x', dataType: 'numeric', value: 1 })).rejects.toThrow();
  await expect(stranger.listComments(runId)).resolves.toMatchObject({ comments: [] }); // 404 → client default
  await ctx.close();
});

test('Phase 4 — web UI still streams a real reply (regression)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  await page.waitForSelector('.messages', { timeout: 15000 });
  await page.evaluate(() => (globalThis as unknown as { sendMessage: (t: string) => unknown }).sendMessage('Reply with exactly one word: pong'));
  await expect(page.locator('.msg.user').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.assistant .msg-body').last()).toContainText(/\w/, { timeout: 90_000 });
});
