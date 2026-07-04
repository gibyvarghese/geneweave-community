/**
 * Playwright E2E — Suggested / starter prompts (m146, Round 10). Proves the acceptance bar:
 *   • API: GET /api/me/suggested-prompts returns curated starters for a fresh user; after the user makes a
 *     NOTE and a CHAT, PERSONALISED starters appear that reference them (notes/chats awareness); a click is
 *     logged (POST); an unknown click is rejected (negative).
 *   • Config: an admin can turn starters off / tune counts via /api/admin/suggested-prompts (Builder tab).
 *   • Real-LLM: through chat, the weave_starter agent's suggest_prompts tool generates AI-personalised
 *     starters from the user's recent activity and CACHES them, so GET then includes an AI starter.
 *   • UI: the empty chat shows clickable starter cards (curated + a "For you" personalised one); clicking a
 *     card sends it (the empty state is replaced by a conversation). Screenshot reviewed vs the design.
 * Run: npm run test:e2e -- suggested-prompts   (API/UI tests need no LLM; the AI test uses the default model).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'sp-owner@weaveintel.dev';
const REAL_LLM = (process.env['DEFAULT_PROVIDER'] ?? (process.env['OPENAI_API_KEY'] ? 'openai' : process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'mock')) !== 'mock';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> {
  return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';
}
interface Prompt { id: string; title: string; prompt: string; source: string }

// ── API: curated defaults → personalised from notes/chats → click log → admin toggle ──
test('suggested-prompts — curated + personalised (notes/chats), click log, admin toggle', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // POSITIVE — a starter list is returned (curated defaults for a user with no special context yet).
  const first = await (await page.request.get(`${origin}/api/me/suggested-prompts`)).json() as { enabled: boolean; prompts: Prompt[] };
  expect(first.enabled).toBe(true);
  expect(first.prompts.length).toBeGreaterThan(0);
  expect(first.prompts.some((p) => p.source === 'curated')).toBe(true);

  // Make a NOTE and a CHAT with distinctive titles → personalised starters should reference them.
  await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Q3 Roadmap Planning' } });
  await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Vendor negotiation notes' } });

  const personalised = await (await page.request.get(`${origin}/api/me/suggested-prompts`)).json() as { prompts: Prompt[] };
  expect(personalised.prompts.some((p) => p.source === 'note' && p.title.includes('Q3 Roadmap')), 'a note-based starter appears').toBeTruthy();
  expect(personalised.prompts.some((p) => p.source === 'chat' && p.title.includes('Vendor negotiation')), 'a chat-based starter appears').toBeTruthy();
  // Personalised come first (relevance ordering).
  expect(personalised.prompts[0]!.source).not.toBe('curated');

  // POSITIVE — logging a click succeeds.
  const pick = personalised.prompts[0]!;
  const click = await page.request.post(`${origin}/api/me/suggested-prompts/click`, { headers: hdr, data: { promptId: pick.id, title: pick.title, source: pick.source } });
  expect(click.status()).toBe(200);
  // NEGATIVE — a click with no promptId is rejected.
  const bad = await page.request.post(`${origin}/api/me/suggested-prompts/click`, { headers: hdr, data: {} });
  expect(bad.status()).toBe(400);

  // Admin: turn starters OFF → the empty chat gets nothing; then back on.
  await page.request.put(`${origin}/api/admin/suggested-prompts/default`, { headers: hdr, data: { enabled: false } });
  const off = await (await page.request.get(`${origin}/api/me/suggested-prompts`)).json() as { enabled: boolean; prompts: Prompt[] };
  expect(off.enabled).toBe(false);
  expect(off.prompts.length).toBe(0);
  await page.request.put(`${origin}/api/admin/suggested-prompts/default`, { headers: hdr, data: { enabled: true, max_personalized: 2, max_curated: 3 } });
  const back = await (await page.request.get(`${origin}/api/me/suggested-prompts`)).json() as { prompts: Prompt[] };
  expect(back.prompts.length).toBeGreaterThan(0);
  expect(back.prompts.length).toBeLessThanOrEqual(6);
});

// ── Real-LLM: the suggest_prompts tool generates + caches AI starters ──
test('suggested-prompts — AI-personalised via suggest_prompts tool (real LLM)', async ({ page }) => {
  test.skip(!REAL_LLM, 'needs a real LLM provider (set OPENAI_API_KEY / ANTHROPIC_API_KEY)');
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Give the user some distinctive recent activity.
  await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Kubernetes migration runbook' } });
  await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Q4 hiring plan for the data team' } });

  // Ask the assistant (agent mode) to suggest starters using its tool.
  const created = await (await page.request.post(`${origin}/api/chats`, { headers: hdr, data: { title: 'Get ideas' } })).json() as { chat: { id: string } };
  await page.request.post(`${origin}/api/chats/${created.chat.id}/settings`, { headers: hdr, data: { mode: 'agent', enabledTools: ['suggest_prompts'] } });
  const stream = await page.request.post(`${origin}/api/chats/${created.chat.id}/messages/stream`, { headers: hdr, data: { content: 'I am not sure what to ask. Suggest a few conversation starters based on what I have been working on, using your tool.' } });
  await stream.body();

  // The cached AI starters should now surface in the empty-chat list.
  const list = await (await page.request.get(`${origin}/api/me/suggested-prompts`)).json() as { prompts: Prompt[] };
  expect(list.prompts.some((p) => p.source === 'ai'), 'an AI-generated starter is cached + returned').toBeTruthy();
});

// ── UI: the empty chat shows starter cards; clicking one starts a conversation ──
test('suggested-prompts — UI starter cards render + click sends', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page), 'content-type': 'application/json' };

  // Ensure there's a personalised card to show, and starters are on.
  await page.request.put(`${origin}/api/admin/suggested-prompts/default`, { headers: hdr, data: { enabled: true } });
  await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Launch checklist' } });
  await page.reload();
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });

  // Start a fresh empty chat so the starter cards render.
  await page.evaluate(() => { const w = window as any; if (w.createChat) return w.createChat(); });
  const grid = page.locator('.suggested-prompts');
  await expect(grid).toBeVisible({ timeout: 8000 });
  await expect(grid.locator('.prompt-card')).not.toHaveCount(0);
  // A personalised "For you" card is present.
  await expect(grid.locator('.prompt-card.personalized').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/suggested-prompts-empty-chat.png', fullPage: false });

  // Click a curated card → it should send + replace the empty state with a conversation.
  const curated = grid.locator('.prompt-card:not(.personalized)').first();
  await curated.click();
  await expect(page.locator('.suggested-prompts')).toHaveCount(0, { timeout: 10000 });
});
