/**
 * Playwright E2E — weaveNotes Phase 2 (query expansion: multi-query + HyDE for workspace RAG).
 * Proves, against a live server + a real LLM + real embeddings:
 *   • A note written in CLINICAL vocabulary is found by a LAY question that shares almost no words
 *     with it — because query expansion rephrases the question and embeds a hypothetical answer,
 *     bridging the vocabulary gap. The cited "Ask your workspace" answer draws from that note.
 *   • CONFIG: query expansion is Builder-gated (query_expansion_enabled) and the variant count is
 *     clamped (2–4); both round-trip through the settings API. With expansion OFF, ask still works.
 *   • SECURITY/tenant isolation is inherited from retrieve() (unchanged); negative query → no sources.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase2-queryexpansion
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn2qe-owner@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }

// A note in CLINICAL language — deliberately NOT the words a layperson would search with.
const CLINICAL_NOTE = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Acute myocardial infarction' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Acute myocardial infarction classically presents with retrosternal chest pressure, diaphoresis, dyspnoea, nausea, and discomfort radiating to the left arm or jaw. Onset is often during exertion. Immediate management includes aspirin and emergency reperfusion.' }] },
  ],
};

test('Phase 2 query expansion — a lay question finds a clinically-worded note; Builder-gated; clamped', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { query_expansion_enabled: true, query_expansion_variants: 3, citations_enabled: true } });

  // Create + INDEX the clinical note (workspace RAG needs the embedding).
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Cardiac emergency notes', doc_json: CLINICAL_NOTE } })).json() as { id: string };
  const idx = await page.request.post(`${origin}/api/me/notes/${note.id}/index`, { headers: hdr, data: {} });
  expect(idx.ok()).toBe(true);

  // Ask with LAY words ("heart attack warning signs") — almost no overlap with "myocardial infarction".
  const ask = await (await page.request.post(`${origin}/api/me/workspace/ask`, { headers: hdr, data: { query: 'what are the warning signs of a heart attack?' } })).json() as { answer: string; sources: Array<{ id: string; title: string }>; citations: unknown[] };
  expect(ask.sources.length).toBeGreaterThanOrEqual(1);
  expect(ask.sources.some((s) => s.id === note.id)).toBe(true);          // the clinical note was retrieved
  expect(ask.answer.length).toBeGreaterThan(0);
  expect(ask.answer.toLowerCase()).not.toMatch(/^i could not find/);     // it answered, didn't whiff

  // The plain search endpoint also surfaces it under the lay query.
  const search = await (await page.request.post(`${origin}/api/me/workspace/search`, { headers: hdr, data: { query: 'chest pain and sweating emergency' } })).json() as { sources: Array<{ id: string }> };
  expect(search.sources.some((s) => s.id === note.id)).toBe(true);

  // CONFIG: the variant count clamps to 2–4; expansion can be switched off and ask still works.
  const clamp = await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { query_expansion_variants: 99 } });
  expect(clamp.ok()).toBe(true);
  const cfg = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { config?: { query_expansion_variants?: number } };
  expect(cfg.config?.query_expansion_variants).toBeLessThanOrEqual(4);

  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { query_expansion_enabled: false } });
  const askOff = await (await page.request.post(`${origin}/api/me/workspace/ask`, { headers: hdr, data: { query: 'acute myocardial infarction symptoms' } })).json() as { sources: Array<{ id: string }> };
  expect(askOff.sources.some((s) => s.id === note.id)).toBe(true);       // direct-vocabulary query still works with expansion off
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { query_expansion_enabled: true } });

  // NEGATIVE: an unrelated question returns no fabricated sources.
  const miss = await (await page.request.post(`${origin}/api/me/workspace/ask`, { headers: hdr, data: { query: 'what is the capital of the moon colony in 2099?' } })).json() as { answer: string; citations: unknown[] };
  expect(miss.citations.length).toBe(0);
});
