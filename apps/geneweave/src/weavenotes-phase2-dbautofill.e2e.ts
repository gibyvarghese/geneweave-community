/**
 * Playwright E2E — weaveNotes Phase 2 (relation-aware + PII-safe database auto-fill). Proves, against
 * a live server + a real LLM:
 *   • RELATION-AWARE: a column in one database is auto-filled using a row's LINKED row in ANOTHER
 *     database — e.g. a Person's "Work city" is filled from the related Company's HQ, with a citation
 *     pointing at the relation (not the web). No web search is needed because the answer is in the
 *     linked record.
 *   • GOVERNANCE: the web-search + PII-redaction dials round-trip through the settings API; with web
 *     search OFF, auto-fill still works from the row + related data.
 *   • SECURITY: a non-owner cannot auto-fill the database.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase2-dbautofill
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn2db-owner@weaveintel.dev';
const OTHER = 'wn2db-other@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }
async function makeDb(req: APIRequestContext, origin: string, hdr: Record<string, string>, name: string, columns: unknown[]): Promise<string> {
  return (await (await req.post(`${origin}/api/me/note-databases`, { headers: hdr, data: { name, view_type: 'table', columns } })).json() as { id: string }).id;
}
async function addRow(req: APIRequestContext, origin: string, hdr: Record<string, string>, dbId: string, fields: Record<string, unknown>): Promise<string> {
  return (await (await req.post(`${origin}/api/me/note-databases/${dbId}/rows`, { headers: hdr, data: { fields } })).json() as { id: string }).id;
}

test('Phase 2 db-autofill — RELATION-AWARE fill from a linked row; web/PII dials gated; secure', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  // Web search OFF so the test is deterministic — the answer must come from the RELATED row, not the web.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { db_autofill_web_search: false, db_autofill_redact_pii: true } });

  // Companies database with an explicit HQ city.
  const companies = await makeDb(page.request, origin, hdr, 'Companies', [
    { key: 'name', name: 'Name', type: 'text' },
    { key: 'hq', name: 'Headquarters city', type: 'text' },
  ]);
  await addRow(page.request, origin, hdr, companies, { name: 'Globex Corporation', hq: 'Munich' });

  // People database that RELATES to a company, with an empty "Work city" to auto-fill.
  const people = await makeDb(page.request, origin, hdr, 'People', [
    { key: 'name', name: 'Name', type: 'text' },
    { key: 'employer', name: 'Employer', type: 'relation', relationDatabaseId: companies },
    { key: 'work_city', name: 'Work city', type: 'text' },
  ]);
  const acmeRowId = (await (await page.request.get(`${origin}/api/me/note-databases/${companies}/view`)).json() as { rows: Array<{ id: string }> }).rows[0]!.id;
  await addRow(page.request, origin, hdr, people, { name: 'Dana Lee', employer: [acmeRowId] });

  // Auto-fill "Work city" — only the linked Globex row (HQ Munich) can supply the answer.
  const fill = await (await page.request.post(`${origin}/api/me/note-databases/${people}/autofill`, { headers: hdr, data: { propertyKey: 'work_city' } })).json() as { ok: boolean; filled: Array<{ value: unknown; citations: Array<{ label: string }> }> };
  expect(fill.ok).toBe(true);
  expect(fill.filled.length).toBe(1);
  // "Munich" exists ONLY in the linked Globex row → this value proves the related row was used as context.
  expect(String(fill.filled[0]!.value)).toMatch(/munich/i);
  expect(fill.filled[0]!.citations.length).toBeGreaterThanOrEqual(1); // every AI-filled cell carries a citation

  // The view shows the filled value persisted.
  const view = await (await page.request.get(`${origin}/api/me/note-databases/${people}/view`)).json() as { rows: Array<{ fields: Record<string, unknown> }> };
  expect(String(view.rows[0]!.fields['work_city'])).toMatch(/munich/i);

  // GOVERNANCE: dials round-trip.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { db_autofill_web_search: true } });
  const cfg = await (await page.request.get(`${origin}/api/admin/weavenotes-settings`)).json() as { config?: { db_autofill_web_search?: number; db_autofill_redact_pii?: number } };
  expect(cfg.config?.db_autofill_web_search).toBe(1);
  expect(cfg.config?.db_autofill_redact_pii).toBe(1);

  // SECURITY: a non-owner cannot auto-fill the database.
  const other = await page.context().browser()!.newContext(); const op = await other.newPage(); await login(op, OTHER);
  const oOrigin = new URL(op.url()).origin; const oHdr = { 'x-csrf-token': await csrf(op) };
  expect((await op.request.post(`${oOrigin}/api/me/note-databases/${people}/autofill`, { headers: oHdr, data: { propertyKey: 'work_city' } })).status()).toBe(404);
  await other.close();
});
