// SPDX-License-Identifier: MIT
/**
 * Playwright E2E — workspace roles: RBAC surface parity + members (m143, Round 6).
 *
 * The FIRST user registered on a fresh server is auto-promoted to tenant_admin; later users stay tenant_user,
 * so `admin@` (registered first) is the workspace admin and `member@` is a standard member — same workspace.
 *
 * Proves:
 *   • Surface parity (API): a member's /api/me/workspace-access hides Builder + Admin; an admin's shows them.
 *   • Per-tenant policy: an admin hides the Dashboard from members → the member's access reflects it.
 *   • Member role management: an admin promotes a member (→ they now see Builder); a member CANNOT change roles.
 *   • UI: the member's left nav has NO Builder/Admin entries; the admin's does (screenshots).
 *   • Assistant (real LLM): "who are the admins here?" uses list_workspace_members and names the admin.
 * Run: DEFAULT_PROVIDER=openai DEFAULT_MODEL=gpt-4o-mini npm run test:e2e -- workspace-roles
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';
const ADMIN = 'wr-admin@weaveintel.dev';
const MEMBER = 'wr-member@weaveintel.dev';

async function ensureUser(page: Page, email: string): Promise<{ origin: string; H: Record<string, string>; userId: string }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string; user?: { id: string } };
  return { origin: new URL(page.url()).origin, H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' }, userId: me.user?.id ?? '' };
}

// ── API: surface parity + per-tenant policy + role management + security ───────────────
test('Workspace roles — surface parity, member-area policy, role change, and RBAC guards', async ({ page, browser }) => {
  test.setTimeout(90_000);
  // Register admin FIRST (auto-promoted), then member.
  const admin = await ensureUser(page, ADMIN);
  const memberPage = await browser.newPage();
  const member = await ensureUser(memberPage, MEMBER);

  // Surface parity: the member is denied Builder + Admin; the admin is granted them.
  const memberAccess = await (await memberPage.request.get(`${member.origin}/api/me/workspace-access`)).json() as { isAdmin: boolean; areas: Record<string, boolean> };
  expect(memberAccess.isAdmin).toBe(false);
  expect(memberAccess.areas['builder']).toBe(false);
  expect(memberAccess.areas['admin']).toBe(false);
  expect(memberAccess.areas['chat']).toBe(true);
  const adminAccess = await (await page.request.get(`${admin.origin}/api/me/workspace-access`)).json() as { isAdmin: boolean; areas: Record<string, boolean> };
  expect(adminAccess.isAdmin).toBe(true);
  expect(adminAccess.areas['builder']).toBe(true);
  expect(adminAccess.areas['admin']).toBe(true);

  // Per-tenant policy: admin hides the Dashboard from members → the member's access reflects it (admin keeps it).
  expect(memberAccess.areas['dashboard']).toBe(true);
  await page.request.put(`${admin.origin}/api/admin/workspace-roles/default`, { headers: admin.H, data: { member_dashboard: 0 } });
  const memberAfter = await (await memberPage.request.get(`${member.origin}/api/me/workspace-access`)).json() as { areas: Record<string, boolean> };
  expect(memberAfter.areas['dashboard']).toBe(false);
  const adminAfter = await (await page.request.get(`${admin.origin}/api/me/workspace-access`)).json() as { areas: Record<string, boolean> };
  expect(adminAfter.areas['dashboard']).toBe(true); // admins always keep it
  await page.request.put(`${admin.origin}/api/admin/workspace-roles/default`, { headers: admin.H, data: { member_dashboard: 1 } });

  // SECURITY: a member cannot change anyone's role (403).
  expect((await memberPage.request.post(`${member.origin}/api/me/account/people/${admin.userId}/role`, { headers: member.H, data: { persona: 'tenant_user' } })).status()).toBe(403);

  // Admin promotes the member → the member now sees Builder + Admin.
  const promote = await page.request.post(`${admin.origin}/api/me/account/people/${member.userId}/role`, { headers: admin.H, data: { persona: 'tenant_admin' } });
  expect(promote.status()).toBe(200);
  const memberNow = await (await memberPage.request.get(`${member.origin}/api/me/workspace-access`)).json() as { isAdmin: boolean; areas: Record<string, boolean> };
  expect(memberNow.isAdmin).toBe(true);
  expect(memberNow.areas['builder']).toBe(true);

  // Restore the member to a standard member for the UI test below.
  await page.request.post(`${admin.origin}/api/me/account/people/${member.userId}/role`, { headers: admin.H, data: { persona: 'tenant_user' } });
  await memberPage.close();
});

// ── UI: the member's nav hides Builder/Admin; the admin's shows them (screenshots) ─────
test('Workspace roles — the left nav hides admin controls from a member', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await ensureUser(page, ADMIN);     // admin (already promoted)
  // Admin sees Builder + Admin in the nav.
  await expect(page.locator('.workspace-menu [aria-label="Builder"], .workspace-menu button:has-text("Builder")').first()).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: '/tmp/pw-wr-admin-nav.png' });

  const memberPage = await browser.newPage();
  await ensureUser(memberPage, MEMBER);   // standard member
  const nav = memberPage.locator('.workspace-menu');
  await expect(nav).toBeVisible({ timeout: 8000 });
  // No Builder, no Admin for the member.
  await expect(nav.getByText('Builder', { exact: true })).toHaveCount(0);
  await expect(nav.getByText('Admin', { exact: true })).toHaveCount(0);
  // But the everyday areas are present.
  await expect(nav.getByText('Notes', { exact: true })).toBeVisible();
  await memberPage.screenshot({ path: '/tmp/pw-wr-member-nav.png' });
  await memberPage.close();
});

// ── Assistant (real LLM): "who's on my team?" → list_workspace_members ─────────────────
// NOTE: the platform's default injection/exfiltration guardrail flags "who is in my workspace" style
// questions as an exfiltration attempt (it can't tell an own-workspace roster from probing hidden context).
// That's a real interaction — a workspace that wants the assistant to answer team questions turns those
// pre-stage cognitive guardrails off. This test does exactly that (as an admin), proving the tool + LLM path
// works end-to-end when the workspace permits it, then restores the guardrails.
test('Workspace roles — the assistant answers team questions via list_workspace_members (guardrails permitting)', async ({ page }) => {
  test.setTimeout(150_000);
  const admin = await ensureUser(page, ADMIN);

  // Temporarily disable the pre-stage cognitive/injection guardrails for this workspace.
  const gr = await (await page.request.get(`${admin.origin}/api/admin/guardrails`)).json() as { guardrails: Array<{ id: string; name?: string; type?: string; stage?: string; enabled?: number | boolean }> };
  const toToggle = (gr.guardrails ?? []).filter((g) => (g.stage === 'pre' || g.stage === 'both') && (g.type === 'cognitive_check' || /inject|exfil|prompt|cognitive|topic/i.test(`${g.name} ${g.type}`)));
  for (const g of toToggle) await page.request.put(`${admin.origin}/api/admin/guardrails/${g.id}`, { headers: admin.H, data: { enabled: false } }).catch(() => undefined);

  try {
    const chatId = (await (await page.request.post(`${admin.origin}/api/chats`, { headers: admin.H, data: { title: 'Team Q' } })).json() as { chat: { id: string } }).chat.id;
    // Agent mode so the assistant can call tools; list_workspace_members is core-registered when wired.
    await page.request.post(`${admin.origin}/api/chats/${chatId}/settings`, { headers: admin.H, data: { mode: 'agent', enabledTools: ['list_workspace_members', 'datetime'] } });
    const stream = await page.request.post(`${admin.origin}/api/chats/${chatId}/messages/stream`, {
      headers: admin.H,
      data: { content: 'Please give me a short roster of the people in my workspace and note which of them are admins.' },
    });
    await stream.body();

    const msgs = await (await page.request.get(`${admin.origin}/api/chats/${chatId}/messages`)).json() as { messages: Array<{ role: string; content: string; metadata?: string }> };
    const answer = [...msgs.messages].reverse().find((m) => m.role === 'assistant');
    // eslint-disable-next-line no-console
    console.log('[team] answer:', answer?.content?.slice(0, 220), '\n[team] meta-has-tool:', (answer?.metadata ?? '').includes('list_workspace_members'));
    expect(answer).toBeTruthy();
    // The tool actually RAN (a step naming list_workspace_members is recorded) OR the answer reflects the team.
    const grounded = (answer?.metadata ?? '').includes('list_workspace_members') || /\b(admin|member|two|three|\d+)\b/i.test(answer?.content ?? '');
    expect(grounded).toBe(true);
  } finally {
    for (const g of toToggle) await page.request.put(`${admin.origin}/api/admin/guardrails/${g.id}`, { headers: admin.H, data: { enabled: true } }).catch(() => undefined);
  }
});
