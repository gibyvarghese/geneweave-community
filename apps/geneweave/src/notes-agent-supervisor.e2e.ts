/**
 * weaveNotes — note AI buttons drive the SUPERVISOR via the API.
 *
 * POST /api/me/notes/:id/ai/agent runs the request through the geneWeave supervisor (modeOverride:
 * 'supervisor'), which delegates to the weaveNotes Editor worker agent; the worker calls the
 * create_diagram / restructure_note tool and stages a suggestion on the note. The ephemeral chat the
 * supervisor uses is deleted afterwards, so the user's chat history stays clean.
 *
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- notes-agent-supervisor
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99', E = 'noteagent@weaveintel.dev';
const SHOT = '/private/tmp/claude-501/-Users-gibyvarghese-weaveintel/0cefaca8-142c-42d3-a6ee-29842fff7652/scratchpad';
const SEED = JSON.stringify({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Photosynthesis' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Inputs' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Light, water and carbon dioxide.' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Outputs' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Glucose and oxygen, made in the chloroplast.' }] },
] });

async function login(page: Page): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'na', email: E, password: PW } });
  await page.request.post('/api/auth/login', { data: { email: E, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}

test.describe('note buttons drive the supervisor (real LLM)', () => {
  test.describe.configure({ retries: 2 });

  test('Make a diagram → supervisor delegates to the worker → create_diagram staged; chat cleaned up', async ({ page }) => {
    test.setTimeout(220_000);
    const { origin, H } = await login(page);
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Agent diagram', doc_json: SEED } })).json() as { id: string };
    const chatsBefore = (await (await page.request.get(`${origin}/api/chats`)).json() as { chats?: unknown[] }).chats?.length ?? 0;

    const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/agent`, { headers: H, data: { action: 'diagram', instruction: 'a flow from light + water + CO2 to glucose + oxygen' } });
    const body = await r.json() as { ok: boolean; via?: string; staged?: Array<{ action: string }> };
    // eslint-disable-next-line no-console
    console.log('[agent] diagram response:', JSON.stringify(body));
    expect(body.via).toBe('supervisor');
    expect(body.ok).toBe(true);
    expect((body.staged ?? []).some((s) => s.action === 'create_diagram')).toBe(true);

    // The suggestion really exists on the note as a pending track-changes card.
    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    expect(pend.suggestions.some((s) => s.action === 'create_diagram')).toBe(true);

    // The ephemeral supervisor chat was deleted — the user's chat history did not grow.
    const chatsAfter = (await (await page.request.get(`${origin}/api/chats`)).json() as { chats?: unknown[] }).chats?.length ?? 0;
    expect(chatsAfter).toBe(chatsBefore);
  });

  test('Restructure → supervisor delegates to the worker → restructure_note staged', async ({ page }) => {
    test.setTimeout(220_000);
    const { origin, H } = await login(page);
    const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Agent restructure', doc_json: SEED } })).json() as { id: string };

    const r = await page.request.post(`${origin}/api/me/notes/${note.id}/ai/agent`, { headers: H, data: { action: 'restructure', outline: 'Outputs\nInputs' } });
    const body = await r.json() as { ok: boolean; via?: string; staged?: Array<{ action: string }> };
    // eslint-disable-next-line no-console
    console.log('[agent] restructure response:', JSON.stringify(body));
    expect(body.via).toBe('supervisor');
    expect((body.staged ?? []).some((s) => s.action === 'restructure_note')).toBe(true);
    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    expect(pend.suggestions.some((s) => s.action === 'restructure_note')).toBe(true);
  });

  test('UI: clicking the ⇅ Restructure button drives the supervisor → worker → inline suggestion', async ({ page }) => {
    test.setTimeout(220_000);
    const { origin, H } = await login(page);
    await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Button restructure', doc_json: SEED } })).json() as { id: string };
    const note = (await (await page.request.get(`${origin}/api/me/notes`)).json() as { notes: Array<{ id: string; title: string }> }).notes.find((n) => n.title === 'Button restructure')!;
    // The Restructure button asks for an optional outline via window.prompt → accept blank (AI chooses).
    page.on('dialog', (d) => void d.accept(''));
    await page.evaluate(() => window.localStorage.setItem('geneweave.uiState.v1', JSON.stringify({ view: 'notes' })));
    await page.goto('/');
    await page.getByText('Button restructure', { exact: true }).first().click({ timeout: 15000 });
    await expect(page.locator('.notes-editor-mount')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.notes-ai-restructure')).toBeVisible({ timeout: 10000 });
    await page.locator('.notes-ai-restructure').click();
    // The reorganised note arrives as an inline track-changes suggestion card in the note.
    await expect(page.locator('.notes-diff').first()).toBeVisible({ timeout: 200_000 });
    const pend = await (await page.request.get(`${origin}/api/me/notes/${note.id}/suggestions?status=pending`)).json() as { suggestions: Array<{ action: string }> };
    expect(pend.suggestions.some((s) => s.action === 'restructure_note')).toBe(true);
    await page.screenshot({ path: `${SHOT}/gw-supervisor-restructure.png`, fullPage: true });
  });
});
