// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — Answer citations in chat (m138). Real managed server + real LLM + real embeddings.
 *
 * Proves the acceptance bar for bringing the notes "Ask your workspace" VERIFIED-citation engine to chat:
 *   • Config + admin round-trip: GET my config; an admin PUT changes enabled/strictness/scope; GET reflects.
 *   • Validation/security: empty question → 400; unknown chat → 404; another user cannot cite into / read my chat.
 *   • Grounded answer (real LLM): a cited answer over the user's own notes, every quote VERBATIM in its source,
 *     persisted (message + message_citations), and the coverage/grounded flags set.
 *   • Anti-hallucination: a question with no workspace support returns NO citations + grounded:false (never a
 *     fabricated source).
 *   • UI: the composer "Cite sources" toggle → a cited answer renders inline [n] chips + verified source cards;
 *     screenshots reviewed against the citation design language.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- answer-citations
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const OWNER = 'ac-owner@weaveintel.dev';
const OTHER = 'ac-other@weaveintel.dev';

async function login(page: Page, email: string): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}
function noteDoc(title: string, body: string) {
  return { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
    { type: 'paragraph', content: [{ type: 'text', text: body }] },
  ] };
}
async function makeAndIndex(page: Page, origin: string, H: Record<string, string>, title: string, body: string): Promise<string> {
  const id = (await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title, doc_json: noteDoc(title, body) } })).json() as { id: string }).id;
  await page.request.post(`${origin}/api/me/notes/${id}/index`, { headers: H, data: {} });
  return id;
}
function plain(docJson: string): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => { if (!n || typeof n !== 'object') return; const o = n as Record<string, unknown>; if (o['type'] === 'text' && typeof o['text'] === 'string') parts.push(o['text']); if (Array.isArray(o['content'])) for (const c of o['content']) walk(c); };
  try { walk(JSON.parse(docJson)); } catch { /* */ }
  return parts.join('');
}
const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

type Cite = { n: number; sourceId: string; sourceKind: string; sourceTitle: string; quote: string; charStart: number; charEnd: number };
type CiteResp = { messageId: string; userMessageId: string; answer: string; citations: Cite[]; sources: Array<{ n: number; id: string; title: string }>; grounded: boolean; groundingNote?: string };

// ── Config + admin round-trip + validation + isolation (deterministic) ────────────────
test('Answer citations — config, admin round-trip, validation, cross-user isolation', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page, OWNER);

  // Default config: enabled, all-corpus.
  const cfg = await (await page.request.get(`${origin}/api/me/chat-citations`)).json() as { enabled: boolean; scope: string; minCitations: number };
  expect(cfg.enabled).toBe(true);
  expect(cfg.scope).toBe('all');

  // Admin changes strictness + scope; GET reflects; then restore.
  const put = await page.request.put(`${origin}/api/admin/chat-citations/default`, { headers: H, data: { enabled: 1, min_citations: 2, scope: 'notes', max_sources: 8 } });
  expect(put.status()).toBe(200);
  const got = await (await page.request.get(`${origin}/api/admin/chat-citations/default`)).json() as { tenants: Record<string, unknown> };
  expect(got.tenants['min_citations']).toBe(2);
  expect(got.tenants['scope']).toBe('notes');
  await page.request.put(`${origin}/api/admin/chat-citations/default`, { headers: H, data: { enabled: 1, min_citations: 1, scope: 'all', max_sources: 6 } });

  // A chat to cite into.
  const chatId = (await (await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Cite test' } })).json() as { chat: { id: string } }).chat.id;

  // VALIDATION: empty question → 400; unknown chat → 404.
  expect((await page.request.post(`${origin}/api/me/chats/${chatId}/cite`, { headers: H, data: { question: '  ' } })).status()).toBe(400);
  expect((await page.request.post(`${origin}/api/me/chats/does-not-exist/cite`, { headers: H, data: { question: 'hi' } })).status()).toBe(404);

  // ISOLATION: another user cannot cite into / read the owner's chat.
  const other = await browser.newPage();
  const o = await login(other, OTHER);
  expect((await other.request.post(`${o.origin}/api/me/chats/${chatId}/cite`, { headers: o.H, data: { question: 'hi' } })).status()).toBe(404);
  expect((await other.request.get(`${o.origin}/api/me/chats/${chatId}/messages/x/citations`)).status()).toBe(404);
  await other.close();
});

// ── Grounded cited answer + anti-hallucination (real LLM + embeddings) ─────────────────
test('Answer citations — grounded answer with VERIFIED quotes, persisted; no support → no citations', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page, OWNER);
  const polaris = await makeAndIndex(page, origin, H, 'Project Polaris', 'Project Polaris launches on 15 March 2026. The total budget is 2 million dollars and the lead engineer is Dana Okafor.');
  await makeAndIndex(page, origin, H, 'Mitochondria', 'Mitochondria are the powerhouse of the cell, producing ATP through cellular respiration.');

  const chatId = (await (await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Polaris Q&A' } })).json() as { chat: { id: string } }).chat.id;

  // Grounded question → cited answer.
  const r = await page.request.post(`${origin}/api/me/chats/${chatId}/cite`, { headers: H, data: { question: 'When does Project Polaris launch and what is the budget?' } });
  expect(r.status()).toBe(200);
  const resp = await r.json() as CiteResp;
  // eslint-disable-next-line no-console
  console.log('[cite] answer:', resp.answer, '\n[cite] citations:', JSON.stringify(resp.citations));
  expect(resp.answer.toLowerCase()).toMatch(/march|2 ?million|budget/);
  expect(resp.citations.length).toBeGreaterThanOrEqual(1);
  expect(resp.grounded).toBe(true);

  // HEADLINE: every citation quote is a real verbatim substring of its source, at the reported span.
  for (const c of resp.citations) {
    const note = await (await page.request.get(`${origin}/api/me/notes/${c.sourceId}`)).json() as { doc_json: string };
    const text = plain(note.doc_json);
    expect(norm(text)).toContain(norm(c.quote));
    expect(norm(text.slice(c.charStart, c.charEnd))).toBe(norm(c.quote));
  }
  expect(resp.citations.some((c) => c.sourceId === polaris)).toBe(true);

  // PERSISTED: the citations survive as their own records, and the assistant message is stored as "cited".
  const stored = await (await page.request.get(`${origin}/api/me/chats/${chatId}/messages/${resp.messageId}/citations`)).json() as { citations: Cite[] };
  expect(stored.citations.length).toBe(resp.citations.length);
  const msgs = await (await page.request.get(`${origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ id: string; role: string; metadata?: string }> };
  const assistant = msgs.messages.find((m) => m.id === resp.messageId);
  expect(assistant?.role).toBe('assistant');
  expect(JSON.parse(assistant?.metadata ?? '{}').cited).toBe(true);

  // ANTI-HALLUCINATION: a question the workspace can't support returns NO citations (never a fake source).
  const neg = await (await page.request.post(`${origin}/api/me/chats/${chatId}/cite`, { headers: H, data: { question: 'What is the capital of the fictional country of Zubrowka?' } })).json() as CiteResp;
  // eslint-disable-next-line no-console
  console.log('[cite-neg] citations:', neg.citations.length, 'grounded:', neg.grounded);
  expect(neg.citations.length).toBe(0);
  expect(neg.grounded).toBe(false);
});

// ── UI: composer toggle → cited answer with chips + source cards (real LLM) ────────────
test('Answer citations — UI toggle produces a cited answer with chips + source cards (screenshots)', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page, OWNER);
  await makeAndIndex(page, origin, H, 'Team Handbook', 'Our support SLA is a four hour first response. Refunds are approved by a team lead. The office is closed on public holidays.');

  const chatId = (await (await page.request.post(`${origin}/api/chats`, { headers: H, data: { title: 'Handbook Q&A' } })).json() as { chat: { id: string } }).chat.id;

  await page.evaluate(async (id: string) => {
    const win = window as unknown as { selectChat?: (id: string) => Promise<void>; state?: { view: string; currentChatId: string | null }; render?: () => void };
    if (win.state) { win.state.view = 'chat'; win.state.currentChatId = id; }
    win.render?.();
    if (win.selectChat) await win.selectChat(id);
  }, chatId);

  // The "Cite sources" toggle is offered (config enabled by default) — turn it on.
  const toggle = page.locator('.cite-toggle');
  await expect(toggle).toBeVisible({ timeout: 8000 });
  await toggle.click();
  await expect(toggle).toHaveClass(/on/);
  await page.screenshot({ path: '/tmp/pw-ac-toggle.png' });

  // Ask a question answerable from the handbook note.
  const textarea = page.locator('textarea[placeholder="Type a message..."]');
  await textarea.fill('What is our support SLA for first response?');
  await page.locator('.send-btn').click();

  // The cited answer renders: inline chip + at least one verified source card.
  await expect(page.locator('.chat-cite-block')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.chat-cite-card').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.chat-cite-chip').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/pw-ac-cited-answer.png', fullPage: true });

  // The source card quotes the handbook.
  const cardText = await page.locator('.chat-cite-card').first().textContent();
  expect((cardText ?? '').toLowerCase()).toMatch(/four hour|sla|response/);
});
