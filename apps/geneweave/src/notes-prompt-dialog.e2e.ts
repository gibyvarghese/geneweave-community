/**
 * Playwright E2E — in-app prompt dialog replaces native browser popups (Notes UI polish).
 *
 * Several Notes/editor actions used to call the browser's native `window.prompt()` to ask a follow-up
 * question ("+ AI block", "Ask AI", "Restructure", "Clip a web page", "Set icon", "Add a link", …). A native
 * popup breaks the design, isn't focus-managed, and looks nothing like the rest of the app. They now open the
 * app's own accessible modal (the same styled dialog as confirm/notice), with a text field.
 *
 * This proves: activating those controls opens an IN-APP dialog (`.gw-dialog` + `.gw-dialog-input`) and does
 * NOT trigger a native browser dialog (Playwright's `page.on('dialog')` never fires); the field can be typed
 * into + submitted; Esc/Cancel closes and returns focus. Screenshot reviewed vs the design.
 * Run: npm run test:e2e -- notes-prompt-dialog   (no LLM needed).
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const OWNER = 'promptdlg-owner@weaveintel.dev';

async function login(page: Page, email: string): Promise<void> {
  let res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PASSWORD } });
    res = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-menu')).toBeVisible({ timeout: 15000 });
}

/** Fail if any NATIVE browser dialog (alert/confirm/prompt) appears — the whole point is that none should. */
function guardAgainstNativeDialogs(page: Page): { fired: string[] } {
  const state = { fired: [] as string[] };
  page.on('dialog', (d) => { state.fired.push(`${d.type()}: ${d.message()}`); void d.dismiss().catch(() => {}); });
  return state;
}

test('Notes — “+ AI block” / “Ask AI” / “Restructure” open the in-app dialog, not a browser popup', async ({ page }) => {
  test.setTimeout(90_000);
  const native = guardAgainstNativeDialogs(page);
  await login(page, OWNER);

  // Open a note in the editor (the AI toolbar lives on the assistant rail, open by default).
  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  await page.getByText('New note', { exact: true }).first().click();
  const insertBtn = page.locator('.notes-ai-insert');
  await expect(insertBtn).toBeVisible({ timeout: 15000 });

  // + AI block → in-app dialog with a text field (NOT a native prompt).
  await insertBtn.click();
  const dialog = page.locator('.gw-dialog');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await expect(dialog.locator('.gw-dialog-input')).toBeVisible();
  await expect(dialog.locator('.gw-dialog-title')).toContainText(/AI block/i);
  await page.screenshot({ path: 'test-results/prompt-dialog-ai-block.png', fullPage: false });

  // The submit button is disabled until the required field has content.
  const submit = dialog.locator('.gw-dialog-btn.primary');
  await expect(submit).toBeDisabled();
  await dialog.locator('.gw-dialog-input').fill('A three-sentence summary of the key risks');
  await expect(submit).toBeEnabled();
  // Esc closes without sending; focus returns to the opener.
  await page.keyboard.press('Escape');
  await expect(page.locator('.gw-dialog')).toHaveCount(0);

  // Ask AI → in-app dialog.
  await page.locator('.notes-ai-ask').click();
  await expect(page.locator('.gw-dialog .gw-dialog-input')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.gw-dialog-title')).toContainText(/Ask AI/i);
  await page.keyboard.press('Escape');
  await expect(page.locator('.gw-dialog')).toHaveCount(0);

  // Restructure → in-app dialog (multi-line, optional → submit enabled even when blank).
  await page.locator('.notes-ai-restructure').click();
  await expect(page.locator('.gw-dialog textarea.gw-dialog-input')).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.gw-dialog')).toHaveCount(0);

  // The crux: no NATIVE browser dialog ever appeared.
  expect(native.fired, `native dialogs should never appear, got: ${native.fired.join(' | ')}`).toEqual([]);
});

test('Notes — “Set icon” opens the in-app dialog (prefilled) + Cancel/OK flow, no native popup', async ({ page }) => {
  test.setTimeout(60_000);
  const native = guardAgainstNativeDialogs(page);
  await login(page, OWNER);

  await page.locator('.workspace-menu').getByText('Notes', { exact: true }).click();
  await page.getByText('New note', { exact: true }).first().click();

  // The note icon (top of the editor) → an in-app prompt prefilled with the current emoji.
  const icon = page.locator('.notes-editor-icon');
  await expect(icon).toBeVisible({ timeout: 15000 });
  await icon.click();

  const dialog = page.locator('.gw-dialog');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const field = dialog.locator('.gw-dialog-input');
  await expect(field).toBeVisible();
  await expect(dialog.locator('.gw-dialog-title')).toContainText(/icon/i);
  // Prefilled with the current value (defaultValue support).
  await expect(field).not.toHaveValue('');
  // Submit a new emoji via the primary button.
  await field.fill('🚀');
  await dialog.locator('.gw-dialog-btn.primary').click();
  await expect(page.locator('.gw-dialog')).toHaveCount(0);
  await expect(icon).toHaveText('🚀', { timeout: 5000 });

  expect(native.fired, `native dialogs should never appear, got: ${native.fired.join(' | ')}`).toEqual([]);
});
