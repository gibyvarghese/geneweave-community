// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 2 — "Ask your workspace" with VERIFIED character-level citations. Real managed
 * server + real LLM + real embeddings.
 *
 * Proves: the AI answers FROM your own notes, and every citation it returns is a VERBATIM quote that
 * provably exists in the cited note (hallucinated quotes are dropped — the headline trust property).
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase2-citations
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99', E = 'wn2-cite@weaveintel.dev';

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'wn2', email: E, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: E, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}
function noteDoc(title: string, body: string) {
  return { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
    { type: 'paragraph', content: [{ type: 'text', text: body }] },
  ] };
}
async function makeAndIndex(page: Page, origin: string, H: Record<string, string>, title: string, body: string): Promise<string> {
  const id = (await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title, doc_json: noteDoc(title, body) } })).json() as { id: string }).id;
  await page.request.post(`${origin}/api/me/notes/${id}/index`, { headers: H, data: {} }); // embed for RAG
  return id;
}
// Extract the plain text of a note exactly as the server does (text nodes joined), to verify quotes.
function plain(docJson: string): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => { if (!n || typeof n !== 'object') return; const o = n as Record<string, unknown>; if (o['type'] === 'text' && typeof o['text'] === 'string') parts.push(o['text']); if (Array.isArray(o['content'])) for (const c of o['content']) walk(c); };
  try { walk(JSON.parse(docJson)); } catch { /* */ }
  return parts.join('');
}

type Ask = { query: string; answer: string; citations: Array<{ n: number; sourceId: string; sourceTitle: string; quote: string; charStart: number; charEnd: number }>; sources: Array<{ n: number; id: string; title: string }> };

test('cited ask — answers FROM the notes and every citation quote is VERIFIABLE in its source', async ({ page }) => {
  test.setTimeout(150_000);
  const { origin, H } = await login(page);
  // A realistic small workspace with distinct, citable facts across notes.
  const polaris = await makeAndIndex(page, origin, H, 'Project Polaris', 'Project Polaris launches on 15 March 2026. The total budget is 2 million dollars and the lead engineer is Dana Okafor.');
  await makeAndIndex(page, origin, H, 'Mitochondria', 'Mitochondria are the powerhouse of the cell, producing ATP through cellular respiration.');
  await makeAndIndex(page, origin, H, 'Water Cycle', 'Evaporation turns water into vapour, condensation forms clouds, and precipitation returns the water as rain.');

  const r = await page.request.post(`${origin}/api/me/workspace/ask`, { headers: H, data: { query: 'When does Project Polaris launch and what is its budget?' } });
  const ask = await r.json() as Ask;
  // eslint-disable-next-line no-console
  console.log('[ask] answer:', ask.answer, '\n[ask] citations:', JSON.stringify(ask.citations));
  expect(r.status()).toBe(200);
  expect(ask.answer.length).toBeGreaterThan(0);
  // The answer is grounded in the Polaris note.
  expect(ask.answer.toLowerCase()).toMatch(/march|2 ?million|budget/);
  expect(ask.citations.length).toBeGreaterThanOrEqual(1);

  // HEADLINE: every citation's quote is a real verbatim substring of its cited source note.
  for (const c of ask.citations) {
    const note = await (await page.request.get(`${origin}/api/me/notes/${c.sourceId}`)).json() as { doc_json: string };
    const text = plain(note.doc_json);
    // verified: the quote appears in the source (normalised for whitespace/case, as locateQuote does).
    const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
    expect(norm(text)).toContain(norm(c.quote));
    // and the char span the server reported actually slices to that quote.
    expect(norm(text.slice(c.charStart, c.charEnd))).toBe(norm(c.quote));
  }
  // At least one citation points at the Polaris note (the right source).
  expect(ask.citations.some((c) => c.sourceId === polaris)).toBe(true);
});

test('cited ask — NEGATIVE: a question with no answer in the notes returns NO fabricated citations', async ({ page }) => {
  test.setTimeout(120_000);
  const { origin, H } = await login(page);
  await makeAndIndex(page, origin, H, 'Lunch order', 'We ordered pizza and salad for the team lunch on Friday.');
  const r = await page.request.post(`${origin}/api/me/workspace/ask`, { headers: H, data: { query: 'What is the airspeed velocity of an unladen swallow?' } });
  const ask = await r.json() as Ask;
  // eslint-disable-next-line no-console
  console.log('[ask-neg] answer:', ask.answer, '| citations:', ask.citations.length);
  // It must NOT invent a citation. Any citation returned must still be verifiable (anti-hallucination
  // holds even on a bad question), but ideally it returns none and says it couldn't find it.
  for (const c of ask.citations) {
    const note = await (await page.request.get(`${origin}/api/me/notes/${c.sourceId}`)).json() as { doc_json: string };
    expect(plain(note.doc_json).replace(/\s+/g, ' ').toLowerCase()).toContain(c.quote.replace(/\s+/g, ' ').toLowerCase());
  }
});
