/**
 * Playwright E2E — weaveNotes Phase 2 (image licence/provenance "Content Credentials"). Proves,
 * against a live server + a real LLM:
 *   • When the assistant draws an SVG illustration, the provenance is GENUINELY EMBEDDED in the SVG's
 *     bytes (kind=ai-illustration, generator, the prompt) — the stored artifact carries it, and the
 *     credentials endpoint reads it back.
 *   • CONFIG: with image provenance turned OFF, no credentials are embedded/stored.
 *   • SECURITY: a non-owner cannot read another user's image credentials.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- weavenotes-phase2-provenance
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'wn2prov-owner@weaveintel.dev';
const OTHER = 'wn2prov-other@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) { await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } }); res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } }); expect(res.status()).toBe(200); }
  await page.goto('/'); await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
}
async function csrf(page: Page): Promise<string> { return (((await (await page.request.get('/api/auth/me')).json()) as { csrfToken?: string }).csrfToken) ?? ''; }

test('Phase 2 provenance — an AI SVG illustration carries embedded Content Credentials; gated; secure', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, OWNER);
  const origin = new URL(page.url()).origin; const hdr = { 'x-csrf-token': await csrf(page) };
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { image_provenance_enabled: true, illustration_enabled: true } });

  const note = await (await page.request.post(`${origin}/api/me/notes`, { headers: hdr, data: { title: 'Provenance note', doc_json: { type: 'doc', content: [] } } })).json() as { id: string };

  // Draw an SVG illustration (real LLM).
  const ill = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/illustration`, { headers: hdr, data: { instruction: 'a simple red apple with a green leaf' } })).json() as { ok: boolean; artifactId?: string | null; error?: string };
  expect(ill.ok).toBe(true);
  expect(ill.artifactId).toBeTruthy();
  const artId = ill.artifactId!;

  // The stored SVG bytes carry the embedded provenance manifest.
  const svg = await (await page.request.get(`${origin}/api/artifacts/${artId}/data`)).text();
  expect(svg).toContain('<metadata id="gw-provenance">');
  expect(svg).toContain('gw-provenance:');
  expect(svg.toLowerCase()).toMatch(/apple/);                 // the prompt is recorded in the manifest

  // The credentials endpoint reads the manifest back.
  const cred = await (await page.request.get(`${origin}/api/me/artifacts/${artId}/credentials`)).json() as { provenance: { kind: string; generator: string; prompt: string } | null };
  expect(cred.provenance).not.toBeNull();
  expect(cred.provenance!.kind).toBe('ai-illustration');
  expect(cred.provenance!.generator).toMatch(/geneWeave/i);
  expect(cred.provenance!.prompt.toLowerCase()).toMatch(/apple/);

  // CONFIG GATING: turn provenance OFF → a new illustration has no embedded credentials.
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { image_provenance_enabled: false } });
  const ill2 = await (await page.request.post(`${origin}/api/me/notes/${note.id}/ai/illustration`, { headers: hdr, data: { instruction: 'a blue circle' } })).json() as { ok: boolean; artifactId?: string | null };
  expect(ill2.ok).toBe(true);
  const svg2 = await (await page.request.get(`${origin}/api/artifacts/${ill2.artifactId}/data`)).text();
  expect(svg2).not.toContain('gw-provenance');
  const cred2 = await (await page.request.get(`${origin}/api/me/artifacts/${ill2.artifactId}/credentials`)).json() as { provenance: unknown };
  expect(cred2.provenance).toBeNull();
  await page.request.put(`${origin}/api/admin/weavenotes-settings`, { headers: hdr, data: { image_provenance_enabled: true } }); // restore

  // SECURITY: a non-owner cannot read the owner's image credentials.
  const other = await page.context().browser()!.newContext(); const op = await other.newPage(); await login(op, OTHER);
  const oOrigin = new URL(op.url()).origin;
  expect((await op.request.get(`${oOrigin}/api/me/artifacts/${artId}/credentials`)).status()).toBe(404);
  await other.close();
});
