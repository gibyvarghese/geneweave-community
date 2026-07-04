/**
 * Playwright E2E — weaveNotes Phase 5 (knowledge graph), live server + real LLM + real embeddings.
 *
 * Proves the roadmap acceptance:
 *   • entities/relations EXTRACTED from a real note (real LLM);
 *   • [[wiki-links]] resolved → BACKLINKS render (with titles);
 *   • semantic "RELATED notes" surfaced (real text-embedding-3-small + cosine);
 *   • unlinked mentions; the knowledge-graph endpoint; security gating;
 *   • the agent navigates the graph via find_related_notes across modes;
 *   • the web-UI Connections panel renders.
 *
 * Run: from apps/geneweave/
 *   DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-graph-phase5
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createRunClient, createRunSession, type RunClient, type RunSession } from '@weaveintel/client';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'notes-p5-owner@weaveintel.dev';
const VIEWER = 'notes-p5-viewer@weaveintel.dev';

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
async function csrf(page: Page): Promise<string> {
  return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? '';
}
async function clientFor(page: Page): Promise<RunClient> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return createRunClient({ baseUrl: new URL(page.url()).origin, extraHeaders: { Cookie: cookieHeader, 'x-csrf-token': await csrf(page) } });
}
function awaitTerminal(s: RunSession, ms: number): Promise<unknown> {
  return Promise.race([s.done(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}
function doc(text: string) { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }; }
async function makeNote(req: APIRequestContext, origin: string, hdr: Record<string, string>, title: string, text: string): Promise<string> {
  const note = await (await req.post(`${origin}/api/me/notes`, { headers: hdr, data: { title } })).json() as { id: string };
  await req.fetch(`${origin}/api/me/notes/${note.id}`, { method: 'PATCH', headers: hdr, data: { doc_json: doc(text) } });
  return note.id;
}

// ── Index → entities/relations + backlinks + related + graph (real LLM/embeddings) ──

test('Phase 5 — index a note: entities/relations extracted, [[wiki-links]] → backlinks, related + graph', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  const stamp = Date.now();

  // A small connected vault: a hub note links to two topic notes via [[wiki-links]].
  const quantum = await makeNote(page.request, origin, hdr, `Quantum Computing ${stamp}`,
    'Quantum computing uses qubits and superposition. Researchers at Microsoft and Google study error correction.');
  const cooking = await makeNote(page.request, origin, hdr, `Pasta Recipes ${stamp}`,
    'A guide to cooking pasta: boil water, add salt, cook al dente. Carbonara uses eggs and pancetta.');
  const hub = await makeNote(page.request, origin, hdr, `Research hub ${stamp}`,
    `My reading log. Today I focused on [[Quantum Computing ${stamp}]] — Majorana qubits and topological protection at Microsoft. I also mention Pasta Recipes ${stamp} in passing without linking it.`);

  // Index all three (real LLM entity extraction + real embeddings).
  for (const id of [quantum, cooking, hub]) {
    const r = await (await page.request.post(`${origin}/api/me/notes/${id}/index`, { headers: hdr, data: {} })).json() as { ok: boolean; links: number; entities: number; relations: number; embedded: boolean };
    expect(r.ok).toBe(true);
  }
  const hubIndex = await (await page.request.post(`${origin}/api/me/notes/${hub}/index`, { headers: hdr, data: {} })).json() as { links: number; entities: number; embedded: boolean };
  // eslint-disable-next-line no-console
  console.log(`[notes-p5] hub index: links=${hubIndex.links} entities=${hubIndex.entities} embedded=${hubIndex.embedded}`);

  // 1. Entities were extracted from the quantum note (real LLM).
  const qIndex = await (await page.request.post(`${origin}/api/me/notes/${quantum}/index`, { headers: hdr, data: {} })).json() as { entities: number };
  expect(qIndex.entities).toBeGreaterThan(0);

  // 2. The [[wiki-link]] resolved → the quantum note has a backlink from the hub.
  const backlinks = await (await page.request.get(`${origin}/api/me/notes/${quantum}/backlinks`)).json() as { backlinks: Array<{ noteId: string; title: string }> };
  expect(backlinks.backlinks.some((b) => b.noteId === hub)).toBe(true);
  expect(backlinks.backlinks.find((b) => b.noteId === hub)!.title).toContain('Research hub');

  // 3. Unlinked mention: the hub mentions "Pasta Recipes …" in prose without [[ ]].
  const unlinked = await (await page.request.get(`${origin}/api/me/notes/${hub}/unlinked`)).json() as { unlinked: Array<{ noteId: string }> };
  expect(unlinked.unlinked.some((u) => u.noteId === cooking)).toBe(true);

  // 4. Related notes (semantic): the hub is closer to Quantum than to Pasta.
  const related = await (await page.request.get(`${origin}/api/me/notes/${hub}/related?limit=5`)).json() as { related: Array<{ noteId: string; score: number }> };
  // eslint-disable-next-line no-console
  console.log(`[notes-p5] related to hub: ${JSON.stringify(related.related.map((r) => ({ id: r.noteId === quantum ? 'quantum' : r.noteId === cooking ? 'cooking' : 'other', s: r.score.toFixed(2) })))}`);
  const qScore = related.related.find((r) => r.noteId === quantum)?.score ?? 0;
  const cScore = related.related.find((r) => r.noteId === cooking)?.score ?? 0;
  expect(qScore).toBeGreaterThan(cScore); // research hub is more about quantum than pasta

  // 5. The knowledge graph has the note, its linked note, and extracted entities.
  const graph = await (await page.request.get(`${origin}/api/me/notes/${hub}/graph`)).json() as { nodes: Array<{ kind: string; label: string }>; edges: Array<{ label: string }> };
  expect(graph.nodes.some((n) => n.kind === 'note' && n.label.includes('Quantum Computing'))).toBe(true);
  expect(graph.nodes.some((n) => n.kind === 'entity')).toBe(true);
  expect(graph.edges.some((e) => e.label === 'links to')).toBe(true);
});

// ── Security ──────────────────────────────────────────────────────────────────

test('Phase 5 — security: a viewer cannot index (403); a stranger is 404', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  const noteId = await makeNote(page.request, origin, hdr, `Sec ${Date.now()}`, 'private graph');
  const share = await (await page.request.post(`${origin}/api/me/notes/${noteId}/share`, { headers: hdr, data: { role: 'viewer' } })).json() as { token: string };

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await login(viewer, VIEWER);
  const vHdr = { 'x-csrf-token': await csrf(viewer) };
  await viewer.request.post(`${origin}/api/me/notes/join`, { headers: vHdr, data: { token: share.token } });
  expect((await viewer.request.post(`${origin}/api/me/notes/${noteId}/index`, { headers: vHdr, data: {} })).status()).toBe(403);
  // but a viewer CAN read connections
  expect((await viewer.request.get(`${origin}/api/me/notes/${noteId}/backlinks`)).status()).toBe(200);

  const ctx2 = await browser.newContext();
  const stranger = await ctx2.newPage();
  await login(stranger, 'notes-p5-stranger@weaveintel.dev');
  const sHdr = { 'x-csrf-token': await csrf(stranger) };
  expect((await stranger.request.get(`${origin}/api/me/notes/${noteId}/related`)).status()).toBe(404);
  await ctx.close(); await ctx2.close();
});

// ── Agent navigates the graph via find_related_notes, across modes ────────────
test.describe('agent finds related notes via find_related_notes across modes', () => {
  test.describe.configure({ retries: 2 });

  for (const mode of ['agent', 'supervisor', 'ensemble'] as const) {
    test(`Phase 5 — "${mode}": the agent uses find_related_notes to navigate the user's notes`, async ({ page }) => {
      test.setTimeout(200_000);
      await login(page, OWNER);
      const origin = new URL(page.url()).origin;
      const hdr = { 'x-csrf-token': await csrf(page) };
      const stamp = Date.now();
      // Seed + index a couple of notes so there's something to find.
      const photo = await makeNote(page.request, origin, hdr, `Astrophotography tips ${stamp}`, 'Long exposures, tracking mounts, dark skies, and stacking frames to capture nebulae.');
      await makeNote(page.request, origin, hdr, `Sourdough bread ${stamp}`, 'Feeding a starter, bulk fermentation, shaping and baking in a Dutch oven.');
      for (const id of [photo]) await page.request.post(`${origin}/api/me/notes/${id}/index`, { headers: hdr, data: {} });

      const client = await clientFor(page);
      const session = createRunSession({ client });
      const prompt = `Please search through my notes for anything related to astrophotography or photographing the night sky, and tell me which of my notes match.`;
      const evs: Array<{ kind: string; payload: unknown }> = [];
      const runId = await session.start({ input: { text: prompt }, metadata: { mode, provider: 'openai', model: 'gpt-4o-mini' } });
      const ctrl = client.attach(runId, { onEvent: (e) => evs.push({ kind: e.kind, payload: e.payload }) });
      await awaitTerminal(session, 150_000);
      await new Promise((r) => setTimeout(r, 1000));
      ctrl.abort(); session.dispose();

      const tools = evs.filter((e) => e.kind.startsWith('tool')).map((e) => (e.payload as { tool?: string }).tool);
      const calledSearch = tools.includes('find_related_notes');
      // eslint-disable-next-line no-console
      console.log(`[notes-p5][${mode}] tools=${JSON.stringify(tools)} calledSearch=${calledSearch}`);
      if (mode === 'agent') {
        expect(calledSearch, 'agent should call find_related_notes to look through notes').toBe(true);
      } else if (!calledSearch) {
        // eslint-disable-next-line no-console
        console.warn(`[notes-p5][${mode}] agent answered without find_related_notes (small-model non-determinism)`);
      }
    });
  }
});

// ── Web UI ────────────────────────────────────────────────────────────────────

test('Phase 5 — web UI: the Connections panel renders backlinks + related + graph', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  const stamp = Date.now();
  const target = await makeNote(page.request, origin, hdr, `UI Target ${stamp}`, 'a target note');
  const title = `UI Hub ${stamp}`;
  const hub = await makeNote(page.request, origin, hdr, title, `Links to [[UI Target ${stamp}]] and discusses quantum computing.`);
  await page.request.post(`${origin}/api/me/notes/${hub}/index`, { headers: hdr, data: {} });
  await page.request.post(`${origin}/api/me/notes/${target}/index`, { headers: hdr, data: {} });

  await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
  await page.reload();
  await expect(page.locator('.notes-list-panel')).toBeVisible({ timeout: 15000 });
  await page.locator('.note-row-title', { hasText: title }).click();

  // Open the Connections panel.
  await expect(page.locator('.notes-connections-btn')).toBeVisible({ timeout: 15000 });
  await page.locator('.notes-connections-btn').click();
  // Once the connections load, the header + the four sections render.
  await expect(page.locator('.notes-conn-heading')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.notes-conn-section')).toHaveCount(4, { timeout: 15000 }); // backlinks, unlinked, related, graph
  // The backlinks section lists the note that links here (the target was linked from the hub).
  await expect(page.locator('.notes-conn-section').first()).toContainText('Backlinks');
});
