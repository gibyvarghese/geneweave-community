/**
 * weaveNotes — a human can EDIT an AI-drawn diagram (rename a node, recolour it, add/delete nodes).
 *
 * The AI authors a `diagram` scene (nodes/edges); this proves that scene is not a frozen picture —
 * the editor's diagram node-view exposes a small toolbar so a human edits the same data, and every
 * change persists back into the note's doc_json through the normal debounced auto-save.
 *
 *   • The diagram renders with an editor toolbar (.gw-diagram-editor) and clickable nodes.
 *   • Clicking a node → renaming it → the new label persists to the saved note.
 *   • '＋ Node' adds a node (it persists too).
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-diagram-edit
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'diagram-edit@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';

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

// An AI-authored diagram: three nodes the human will edit.
const SEED = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Water cycle' }] },
  { type: 'diagram', attrs: { author: 'ai', kind: 'flow', title: 'Water cycle', scene: { kind: 'flow',
    nodes: [{ id: 'a', label: 'Evaporation' }, { id: 'b', label: 'Condensation' }, { id: 'c', label: 'Precipitation' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } } },
] });

function sceneOf(docJson: string): { nodes?: Array<{ id: string; label: string; color?: string }>; edges?: unknown[] } | null {
  const doc = JSON.parse(docJson) as { content?: Array<{ type: string; attrs?: { scene?: any } }> };
  for (const n of doc.content ?? []) if (n.type === 'diagram') return n.attrs?.scene ?? null;
  return null;
}
async function getScene(page: Page, origin: string, id: string): Promise<ReturnType<typeof sceneOf>> {
  const note = await (await page.request.get(`${origin}/api/me/notes/${id}`)).json() as { doc_json: string };
  return sceneOf(note.doc_json);
}

test('a human can edit an AI-drawn diagram — rename a node + add a node, persisted to the note', async ({ page }) => {
  test.setTimeout(90_000);
  page.on('console', (m) => { const t = m.text(); if (t.includes('[diagram]') || t.includes('auto-save')) console.log('[browser]', t); });
  await login(page, OWNER);
  await page.setViewportSize({ width: 1320, height: 1100 });
  const origin = new URL(page.url()).origin;
  const hdr = { 'x-csrf-token': await csrf(page) };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Editable diagram', doc_json: SEED, page_theme: 'creative' } })).json() as { id: string };

  const openNote = async (): Promise<void> => {
    await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
    await page.goto('/');
    await page.getByText('Editable diagram', { exact: true }).first().click({ timeout: 15000 });
    await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.gw-diagram-block svg').first()).toBeVisible({ timeout: 8000 });
  };
  await openNote();

  // The diagram renders WITH an editor toolbar + clickable nodes (the editable affordance).
  await expect(page.locator('.gw-diagram-editor').first()).toBeVisible({ timeout: 8000 });
  const nodeGroups = page.locator('.gw-diagram-block svg [data-node-id]');
  expect(await nodeGroups.count()).toBe(3);

  // ── Edit 1: click a node → rename it → it persists to the saved note ──
  await nodeGroups.first().click({ force: true });
  const labelInput = page.locator('.gw-diagram-label');
  await expect(labelInput).toBeVisible({ timeout: 5000 });
  await labelInput.fill('Runoff (edited by me)');
  await page.waitForTimeout(2200); // debounced auto-save (1.5s) + margin
  let scene = await getScene(page, origin, note.id);
  expect((scene?.nodes ?? []).length).toBe(3);
  expect((scene?.nodes ?? []).some((n) => n.label === 'Runoff (edited by me)')).toBe(true);

  // ── Edit 2: reopen, then in ONE session recolour the selected node AND add a node ──
  // (the realistic flow — an unsaved atom edit that never focuses the editor must not be clobbered
  // by a remote echo before it saves).
  await openNote();
  await page.locator('.gw-diagram-block svg [data-node-id]').first().click({ force: true });
  await expect(page.locator('.gw-diagram-label')).toBeVisible({ timeout: 5000 }); // node selected
  await page.locator('.gw-diagram-swatch').first().click(); // recolour the selected node
  await page.locator('.gw-diagram-btn', { hasText: 'Node' }).first().click(); // add a node
  await expect(page.locator('.gw-diagram-block svg [data-node-id]')).toHaveCount(4, { timeout: 4000 });
  await page.waitForTimeout(3200); // settle: save + echo
  scene = await getScene(page, origin, note.id);
  expect((scene?.nodes ?? []).length).toBe(4); // the added node persisted
  expect((scene?.nodes ?? []).some((n) => n.label === 'New node')).toBe(true);
  // The recolour persisted too (the renamed node carries the swatch colour, not its original).
  const renamed = (scene?.nodes ?? []).find((n) => n.label === 'Runoff (edited by me)');
  expect(renamed?.color).toBeTruthy();

  await page.screenshot({ path: `${SHOT}/gw-diagram-edit.png`, fullPage: true });
});
