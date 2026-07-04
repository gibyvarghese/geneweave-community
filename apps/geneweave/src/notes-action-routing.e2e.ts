/**
 * weaveNotes — per-tenant note action routing is configurable (direct | agent | supervisor).
 *
 *   • Admin: GET/PUT /api/admin/note-action-modes lists + edits the per-(tenant, action) mode (the
 *     Builder "weaveNotes → Action Routing" tab). Seeded global defaults exist.
 *   • Routing: a note action endpoint runs DIRECT (fast service call) or via the SUPERVISOR (which
 *     delegates to the weaveNotes Editor worker) depending on the configured mode — the SAME button
 *     /endpoint, different mode.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-action-routing
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99', E = 'noterouting@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';
const SEED = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'States of matter' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Matter exists as solid, liquid, gas and plasma.' }] },
] });

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'nr', email: E, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: E, password: PW } });
  await page.goto('/');
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}
type ModeRow = { id: string; tenant_id: string; action_key: string; mode: string };
async function modes(page: Page, origin: string): Promise<ModeRow[]> {
  return (await (await page.request.get(`${origin}/api/admin/note-action-modes`)).json() as { 'note-action-modes': ModeRow[] })['note-action-modes'];
}
async function setGlobalMode(page: Page, origin: string, H: Record<string, string>, action: string, mode: string): Promise<void> {
  const row = (await modes(page, origin)).find((r) => r.tenant_id === '' && r.action_key === action);
  if (row) await page.request.put(`${origin}/api/admin/note-action-modes/${row.id}`, { headers: H, data: { tenant_id: '', action_key: action, mode } });
  else await page.request.post(`${origin}/api/admin/note-action-modes`, { headers: H, data: { tenant_id: '', action_key: action, mode } });
}

test('Builder UI: weaveNotes → Action Routing tab renders the per-action modes', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 8000 });
  // Open the weaveNotes group, then the Action Routing tab.
  const tab = page.locator('[data-admin-tab="note-action-modes"]').first();
  if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) {
    if (!(await page.locator('.admin-nav-sub').isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.locator('.admin-parent').click().catch(() => {});
    }
    await page.locator('.admin-group-btn', { hasText: 'weaveNotes' }).click();
  }
  await tab.click({ timeout: 8000 });
  // The table lists the seeded actions + modes.
  await expect(page.locator('.main')).toContainText('diagram', { timeout: 8000 });
  await expect(page.locator('.main')).toContainText('supervisor', { timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/gw-admin-action-routing.png`, fullPage: true });
});

test('Admin: note-action-modes lists seeded defaults and is editable', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page);
  const rows = await modes(page, origin);
  const diagram = rows.find((r) => r.tenant_id === '' && r.action_key === 'diagram');
  expect(diagram).toBeTruthy();
  expect(diagram!.mode).toBe('supervisor'); // shipped default
  // Edit it to direct, read it back.
  await page.request.put(`${origin}/api/admin/note-action-modes/${diagram!.id}`, { headers: H, data: { tenant_id: '', action_key: 'diagram', mode: 'direct' } });
  expect((await modes(page, origin)).find((r) => r.id === diagram!.id)!.mode).toBe('direct');
  // A bad value is rejected.
  const bad = await page.request.put(`${origin}/api/admin/note-action-modes/${diagram!.id}`, { headers: H, data: { tenant_id: '', action_key: 'diagram', mode: 'nonsense' } });
  expect(bad.status()).toBe(400);
});

test('Routing: diagram runs DIRECT when configured direct (fast, no agent)', async ({ page }) => {
  test.setTimeout(90_000);
  const { origin, H } = await login(page);
  await setGlobalMode(page, origin, H, 'diagram', 'direct');
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Route direct', doc_json: SEED } })).json() as { id: string };
  const t0 = Date.now();
  const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/diagram`, { headers: H, data: { instruction: 'a flow of solid → liquid → gas' } });
  const body = await r.json() as { ok: boolean; via?: string };
  const elapsed = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log('[routing] direct via:', body.via, 'elapsed(ms):', elapsed);
  expect(body.via).toBe('direct');
  expect(body.ok).toBe(true);
  const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
  expect(pend.suggestions.some((s) => s.action === 'create_diagram')).toBe(true);
});

test.describe('supervisor routing (real LLM)', () => {
  test.describe.configure({ retries: 2 });
  test('Routing: diagram runs via the SUPERVISOR when configured supervisor (delegates to worker)', async ({ page }) => {
    test.setTimeout(220_000);
    const { origin, H } = await login(page);
    await setGlobalMode(page, origin, H, 'diagram', 'supervisor');
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Route supervisor', doc_json: SEED } })).json() as { id: string };
    const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/diagram`, { headers: H, data: { instruction: 'a flow of solid → liquid → gas' } });
    const body = await r.json() as { ok: boolean; via?: string; staged?: Array<{ action: string }> };
    // eslint-disable-next-line no-console
    console.log('[routing] supervisor via:', body.via, 'staged:', JSON.stringify(body.staged));
    expect(body.via).toBe('supervisor');
    expect((body.staged ?? []).some((s) => s.action === 'create_diagram')).toBe(true);
    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    expect(pend.suggestions.some((s) => s.action === 'create_diagram')).toBe(true);
  });
});
