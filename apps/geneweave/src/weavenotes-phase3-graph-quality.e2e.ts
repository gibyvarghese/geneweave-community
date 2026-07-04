/**
 * Playwright E2E — weaveNotes Phase 3 (knowledge-graph QUALITY / GraphRAG). Proves the acceptance bar
 * — "notes connect through the same real-world thing even when it's written differently, and a
 * workspace re-index embeds in batches, not one-by-one":
 *   • Settings: entity_resolution_enabled + embedding_batch_size are DB-backed + round-trip (Builder).
 *   • Entity DISAMBIGUATION (real LLM): two notes that name the same org with DIFFERENT spellings
 *     ("Globex Corporation" vs "Globex") end up CONNECTED — GET /entity-related returns the sibling,
 *     and the graph shows one canonical entity node shared by both notes.
 *   • BATCHED embeddings (real embeddings): POST /reindex embeds changed notes in one call per batch;
 *     with batch size 2 and 3+ notes, it reports ≥2 batches and embeds them.
 *   • SECURITY: a stranger cannot read entity-related on someone else's note (404).
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase3-graph-quality
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn3gq-owner@weaveintel.dev';
const OTHER = 'wn3gq-other@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
const PARA = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// ── Settings round-trip (deterministic — runs on any server) ─────────────────────────
test('Phase 3 graph quality — settings are DB-backed: entity resolution + embedding batch size persist', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  const get1 = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(get1['weavenotes-settings'][0]!['entity_resolution_enabled']).toBe(1);
  expect(typeof get1['weavenotes-settings'][0]!['embedding_batch_size']).toBe('number');
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { embedding_batch_size: 8, entity_resolution_enabled: false } });
  const got = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(got['weavenotes-settings'][0]!['embedding_batch_size']).toBe(8);
  expect(got['weavenotes-settings'][0]!['entity_resolution_enabled']).toBe(0);
  // out-of-range batch size is clamped (1–64).
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { embedding_batch_size: 9999 } });
  const clamped = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { 'weavenotes-settings': Array<Record<string, unknown>> };
  expect(clamped['weavenotes-settings'][0]!['embedding_batch_size']).toBe(64);
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { embedding_batch_size: 16, entity_resolution_enabled: true } }); // restore
});

// ── Entity disambiguation + cross-note graph + batched embeddings (real LLM) ──────────
test.describe('Phase 3 graph quality — real LLM + embeddings', () => {
  test.describe.configure({ retries: 2 });
  test.skip(!process.env['BASE_URL'], 'needs a real LLM + embeddings — target the dev server via BASE_URL');

  test('two spellings of one org connect the notes; reindex embeds in batches; security', async ({ page, browser }) => {
    test.setTimeout(200_000);
    await login(page, OWNER);
    const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
    await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { entity_resolution_enabled: true, embedding_batch_size: 2 } });

    // Clean slate for this test user so the entity graph is deterministic (no prior-run notes sharing
    // generic entities like "acquisition" that would out-rank the pair we're testing).
    const existing = await (await page.request.get(`${origin}/api/me/notes`)).json() as { notes?: Array<{ id: string }> } | Array<{ id: string }>;
    const existingList = Array.isArray(existing) ? existing : (existing.notes ?? []);
    for (const n of existingList) await page.request.delete(`${origin}/api/me/notes/${n.id}`, { headers: hdr });
    const stamp = Date.now();

    // Two notes naming the SAME company with DIFFERENT surface forms ("Globex Corporation" vs plain
    // "Globex"). Entity resolution folds the legal suffix so both canonicalise to one entity → connected.
    const a = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Merger memo ${stamp}`, doc_json: PARA('We met with Globex Corporation today to discuss the acquisition. Globex Corporation will lead the deal, and Globex Corporation confirmed the budget.') } })).json() as { id: string };
    const b = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Europe expansion ${stamp}`, doc_json: PARA('Globex is opening three new offices across Europe. Globex hired 200 staff, and Globex plans a Berlin launch.') } })).json() as { id: string };
    const c = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Unrelated recipe ${stamp}`, doc_json: PARA('Sourdough needs a starter, long fermentation, and a hot oven.') } })).json() as { id: string };
    // Three MORE notes left un-embedded, so the batched reindex has ≥3 to embed.
    for (const i of [1, 2, 3]) await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: `Filler ${i} ${stamp}`, doc_json: PARA(`Filler note number ${i} with some searchable content ${stamp}.`) } });

    // Index the two org notes so entities are extracted + canonicalised (this also embeds them).
    for (const id of [a.id, b.id]) expect((await page.request.post(`${origin}/api/me/notes/${id}/index`, { headers: hdr, data: {} })).status()).toBe(200);

    // Entity-related: note A is CONNECTED to note B through the shared canonical "Globex" entity.
    const rel = await (await page.request.get(`${origin}/api/me/notes/${a.id}/entity-related?limit=20`)).json() as { related: Array<{ noteId: string; title: string; shared: number; via: string[] }> };
    // eslint-disable-next-line no-console
    console.log(`[wn3gq] entity-related(A) = ${JSON.stringify(rel.related.map((r) => ({ t: r.title, via: r.via })))}`);
    expect(rel.related.some((r) => r.noteId === b.id), 'notes sharing the Globex entity should be connected').toBe(true);
    expect(rel.related.some((r) => r.noteId === c.id), 'the unrelated recipe note must NOT be connected').toBe(false);

    // The graph for A shows a canonical entity node whose label folds the spellings, linked to note B.
    const graph = await (await page.request.get(`${origin}/api/me/notes/${a.id}/graph`)).json() as { nodes: Array<{ id: string; label: string; kind: string }>; edges: Array<{ source: string; target: string }> };
    const entityNodes = graph.nodes.filter((n) => n.kind === 'entity');
    expect(entityNodes.some((n) => /globex/i.test(n.label))).toBe(true);
    expect(graph.nodes.some((n) => n.id === `note:${b.id}`), 'note B appears in A’s graph via the shared entity').toBe(true);

    // BATCHED reindex: 3 notes, batch size 2 → at least 2 batches, and it embeds them.
    const rc = await (await page.request.post(`${origin}/api/me/notes/reindex`, { headers: hdr, data: { extractGraph: false } })).json() as { notes: number; embedded: number; batches: number };
    // eslint-disable-next-line no-console
    console.log(`[wn3gq] reindex = ${JSON.stringify(rc)}`);
    expect(rc.notes).toBeGreaterThanOrEqual(3);
    expect(rc.embedded).toBeGreaterThanOrEqual(3);
    expect(rc.batches).toBeGreaterThanOrEqual(2); // 3 notes / batch size 2 → ≥2 batches (proves batching)

    // UI: open note A, switch to the Links rail, and see the GraphRAG "Connected through" section.
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
    await page.goto('/');
    await page.getByText(`Merger memo ${stamp}`, { exact: false }).first().click({ timeout: 15000 });
    await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
    await page.locator('.gw-rail-tab', { hasText: 'Links' }).click();
    await expect(page.locator('.notes-conn-title', { hasText: 'Connected through' })).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/wn3-graph-connected-through.png' });

    // SECURITY: a stranger cannot read entity-related on the owner's note.
    const ctx = await browser.newContext();
    const intruder = await ctx.newPage();
    await login(intruder, OTHER);
    expect((await intruder.request.get(`${origin}/api/me/notes/${a.id}/entity-related`)).status()).toBe(404);
    await ctx.close();

    await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { embedding_batch_size: 16 } }); // restore
  });
});
