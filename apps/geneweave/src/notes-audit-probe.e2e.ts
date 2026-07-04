/** AUDIT PROBE (throwaway): authz / tenant isolation, SSRF, sanitization, stress, rate-limit. */
import { test, expect, type Page } from '@playwright/test';
const PW = 'Str0ng!Pass99';
async function user(page: Page, email: string): Promise<{ origin: string; H: Record<string,string> }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  const me = await (await page.request.get('/api/auth/me')).json();
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken } };
}

test('AUTHZ — user B cannot read/edit/AI another user\'s note', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctxA = await browser.newContext(); const pA = await ctxA.newPage();
  const a = await user(pA, 'audit-a@weaveintel.dev');
  const note = await (await pA.request.post(`${a.origin}/api/me/notes`, { headers: a.H, data: { title: 'A secret', doc_json: JSON.stringify({ type:'doc', content:[{type:'paragraph',content:[{type:'text',text:'secret'}]}] } ) } })).json();
  const ctxB = await browser.newContext(); const pB = await ctxB.newPage();
  const b = await user(pB, 'audit-b@weaveintel.dev');
  const results: Record<string, number> = {};
  results['B GET A note'] = (await pB.request.get(`${b.origin}/api/me/notes/${note.id}`)).status();
  results['B PATCH A note'] = (await pB.request.patch(`${b.origin}/api/me/notes/${note.id}`, { headers: b.H, data: { title: 'hacked' } })).status();
  results['B diagram on A'] = (await pB.request.post(`${b.origin}/api/me/notes/${note.id}/ai/diagram`, { headers: b.H, data: { instruction: 'x' } })).status();
  results['B find-image on A'] = (await pB.request.post(`${b.origin}/api/me/notes/${note.id}/ai/find-image`, { headers: b.H, data: { query: 'x' } })).status();
  results['B suggestions list A'] = (await pB.request.get(`${b.origin}/api/me/notes/${note.id}/suggestions`)).status();
  results['B export A'] = (await pB.request.get(`${b.origin}/api/me/notes/${note.id}/export?format=markdown`)).status();
  // eslint-disable-next-line no-console
  console.log('[audit] cross-user statuses:', JSON.stringify(results));
  for (const [k, s] of Object.entries(results)) expect.soft(s, k).toBeGreaterThanOrEqual(403);
  await ctxA.close(); await ctxB.close();
});

test('SSRF — capture_web_page refuses private/metadata hosts', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await user(page, 'audit-ssrf@weaveintel.dev');
  const targets = ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3510/', 'http://127.0.0.1:22/', 'http://10.0.0.1/', 'http://[::1]/'];
  const out: Record<string, number> = {};
  for (const t of targets) {
    const r = await page.request.post(`${u.origin}/api/me/notes/capture/web`, { headers: u.H, data: { url: t } }).catch(() => null);
    out[t] = r ? r.status() : -1;
  }
  // eslint-disable-next-line no-console
  console.log('[audit] SSRF capture statuses:', JSON.stringify(out));
  for (const [t, s] of Object.entries(out)) expect.soft(s, t).toBeGreaterThanOrEqual(400);
});

test('SANITIZE — note doc_json with script/onerror is served safely', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await user(page, 'audit-xss@weaveintel.dev');
  const evil = JSON.stringify({ type:'doc', content:[
    { type:'image', attrs:{ src:'javascript:alert(1)', alt:'<img src=x onerror=alert(1)>' } },
    { type:'paragraph', content:[{ type:'text', text:'<script>alert(1)</script>' }] },
  ]});
  const note = await (await page.request.post(`${u.origin}/api/me/notes`, { headers: u.H, data: { title: 'XSS', doc_json: evil } })).json();
  const html = await (await page.request.get(`${u.origin}/api/me/notes/${note.id}/render?format=html`).catch(() => ({ ok:()=>false, text:async()=>'' } as any))).text?.().catch(()=>'') ?? '';
  // eslint-disable-next-line no-console
  console.log('[audit] rendered html has <script>?', /<script/i.test(html), '| has javascript: src?', /src\s*=\s*["']?javascript:/i.test(html), '| sample:', html.slice(0, 200));
});

test('STRESS — large note (2000 blocks): create, GET, export, suggestions timing', async ({ page }) => {
  test.setTimeout(180_000);
  const u = await user(page, 'audit-stress@weaveintel.dev');
  const blocks = Array.from({ length: 2000 }, (_, i) => ({ type:'paragraph', content:[{ type:'text', text:`Paragraph number ${i} with some filler content to make it realistic.` }] }));
  const big = JSON.stringify({ type:'doc', content:[{ type:'heading', attrs:{level:1}, content:[{type:'text',text:'Big'}] }, ...blocks] });
  let t = Date.now();
  const note = await (await page.request.post(`${u.origin}/api/me/notes`, { headers: u.H, data: { title: 'Big note', doc_json: big } })).json();
  const tCreate = Date.now() - t;
  t = Date.now(); const getR = await page.request.get(`${u.origin}/api/me/notes/${note.id}`); const tGet = Date.now() - t;
  t = Date.now(); const expR = await page.request.get(`${u.origin}/api/me/notes/${note.id}/export?format=markdown`); const tExport = Date.now() - t;
  t = Date.now(); const coR = await page.request.post(`${u.origin}/api/me/notes/${note.id}/coedit`, { headers: u.H, data: {} }); const tCoedit = Date.now() - t;
  // eslint-disable-next-line no-console
  console.log('[audit] STRESS ms:', JSON.stringify({ create:tCreate, get:tGet, getStatus:getR.status(), export:tExport, exportStatus:expR.status(), coeditEnsure:tCoedit, coeditStatus:coR.status() }));
});

test('RATE — hammer an AI endpoint to see if there is any limit', async ({ page }) => {
  test.setTimeout(120_000);
  const u = await user(page, 'audit-rate@weaveintel.dev');
  const note = await (await page.request.post(`${u.origin}/api/me/notes`, { headers: u.H, data: { title: 'Rate', doc_json: JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'hi'}]}]}) } })).json();
  const codes: number[] = [];
  for (let i = 0; i < 15; i++) {
    const r = await page.request.post(`${u.origin}/api/me/notes/${note.id}/ai/find-image`, { headers: u.H, data: { query: 'apple' } });
    codes.push(r.status());
  }
  // eslint-disable-next-line no-console
  console.log('[audit] 15x find-image status codes:', JSON.stringify(codes), '| any 429?', codes.includes(429));
});
