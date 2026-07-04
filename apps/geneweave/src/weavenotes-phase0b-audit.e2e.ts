// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0-B / 0-D — audit feed + export + redaction completeness + invite owner-check.
 * Real managed server, real HTTP. (LLM-free.)
 *
 * Run: npm run test:e2e -- weavenotes-phase0b-audit
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const A = 'wn0b-a@weaveintel.dev';
const B = 'wn0b-b@weaveintel.dev';

async function login(page: Page, email: string): Promise<{ origin: string; H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: 'wn0b', email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '' } };
}

test('audit feed — a created note shows in /api/admin/note-activity, with export in CSV/JSON/JSONL', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page, A);
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Audited note', doc_json: { type: 'doc', content: [] } } })).json() as { id: string };

  const feed = await (await page.request.get(`${origin}/api/admin/note-activity?limit=50`)).json() as { 'note-activity': Array<{ note_id: string; action: string; note_title?: string }>; nextCursor: unknown };
  const mine = feed['note-activity'].filter((e) => e.note_id === note.id);
  expect(mine.length).toBeGreaterThanOrEqual(1);
  expect(mine.some((e) => e.action === 'created')).toBe(true);
  expect(mine[0]!.note_title).toBe('Audited note'); // join surfaces the title

  // CSV export — right content-type + a header row + the note title; quoting present.
  const csvRes = await page.request.get(`${origin}/api/admin/note-activity/export?format=csv`);
  expect((csvRes.headers()['content-type'] ?? '')).toContain('text/csv');
  const csv = await csvRes.text();
  expect(csv.split('\n')[0]).toContain('created_at');
  expect(csv).toContain('Audited note');

  // JSON + JSONL exports.
  const jsonRes = await page.request.get(`${origin}/api/admin/note-activity/export?format=json`);
  expect((jsonRes.headers()['content-type'] ?? '')).toContain('application/json');
  expect(Array.isArray(await jsonRes.json())).toBe(true);
  const jsonl = await (await page.request.get(`${origin}/api/admin/note-activity/export?format=jsonl`)).text();
  expect(jsonl.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
});

test('audit export — CSV FORMULA INJECTION is neutralised (a note_title starting with = is apostrophe-guarded)', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page, A);
  // A note title that starts with '=' becomes the note_title CELL in the CSV export. A naive CSV
  // would let a spreadsheet execute it; our export prefixes such cells with an apostrophe.
  await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: '=HYPERLINK("http://evil")', doc_json: { type: 'doc', content: [] } } });
  const csv = await (await page.request.get(`${origin}/api/admin/note-activity/export?format=csv`)).text();
  expect(csv).not.toMatch(/"=HYPERLINK/); // never the raw, executable form
  expect(csv).toMatch(/"'=HYPERLINK/);    // the apostrophe-guarded form
});

test('redaction completeness — secrets in a COLLAPSED toggle, a link href, and image alt never reach the published doc', async ({ page }) => {
  test.setTimeout(60_000);
  const { origin, H } = await login(page, A);
  const SK = 'sk-ABCD1234EFGH5678IJKL';
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Public intro.' }] },
    // Secret hidden inside a COLLAPSED toggle — the classic "I didn't see it" leak.
    { type: 'toggle', attrs: { summary: 'Internal', open: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `deploy key ${SK} do not share` }] }] },
    // Secret in a LINK href (invisible in rendered text).
    { type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: `https://x.example/?token=${JWT}` } }] }] },
    // Secret in IMAGE alt text.
    { type: 'image', attrs: { src: '#', alt: `diagram ${AWS}` } },
  ] };
  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: H, data: { title: 'Has secrets', doc_json: doc } })).json() as { id: string };

  const emit = await (await page.request.post(`${origin}/api/me/notes/${note.id}/emit-artifact`, { headers: H, data: { format: 'markdown', share: false } })).json() as { ok: boolean; artifactId?: string; redactions?: number };
  // eslint-disable-next-line no-console
  console.log('[redaction] result:', JSON.stringify(emit));
  expect(emit.ok).toBe(true);

  // Fetch the PUBLISHED artifact content and assert NONE of the secrets survive (in any field).
  const published = await (await page.request.get(`${origin}/api/artifacts/${emit.artifactId}/data`)).text();
  expect(published).not.toContain(SK);
  expect(published).not.toContain(JWT);
  expect(published).not.toContain(AWS);
});

test('invite owner-check — a non-owner collaborator cannot mint a new share invite', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const a = await login(page, A);
  const note = await (await page.request.post(`${a.origin}/api/me/notes`, { headers: a.H, data: { title: 'Owned by A', doc_json: { type: 'doc', content: [] } } })).json() as { id: string };
  // A mints a collaborator invite and B joins with it.
  const invite = await (await page.request.post(`${a.origin}/api/me/notes/${note.id}/share`, { headers: a.H, data: { role: 'collaborator' } })).json() as { token: string };
  expect(invite.token).toBeTruthy();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await login(pageB, B);
  const joined = await pageB.request.post(`${b.origin}/api/me/notes/join`, { headers: b.H, data: { token: invite.token } });
  expect(joined.ok()).toBeTruthy(); // B is now a collaborator

  // B (collaborator, NOT owner) tries to mint a fresh invite → refused (only the owner may share).
  const bShare = await pageB.request.post(`${b.origin}/api/me/notes/${note.id}/share`, { headers: b.H, data: { role: 'viewer' } });
  // eslint-disable-next-line no-console
  console.log('[invite] B (collaborator) share status:', bShare.status());
  expect(bShare.status()).toBe(404); // getNoteForOwner gate: non-owner cannot create invites
  await ctxB.close();
});
