// SPDX-License-Identifier: MIT
/**
 * Phase 6 gate — the app BOOTS on the fully-consolidated framework (86→45 packages, tools behind
 * subpaths, the Kaggle vertical now app-owned) and serves its documentation.
 *
 * If any retired package name or a broken import survived the restructure, the server would fail to
 * boot; if the docs route regressed, `/docs` would not render. This proves both, end-to-end, in a real
 * browser, and captures a screenshot to review against the geneWeave design.
 */
import { test, expect } from '@playwright/test';

test('the app boots and serves /docs on the consolidated framework', async ({ page }) => {
  const res = await page.goto('/docs');
  expect(res?.status()).toBe(200);
  await page.waitForLoadState('networkidle');

  // The docs page renders the geneWeave brand + real content (not an error page).
  await expect(page.locator('body')).toContainText(/geneWeave|Documentation|Getting started/i);
  // The consolidated tool library shows up in the docs (no stale sub-package names broke the page).
  const html = await page.content();
  expect(html).toContain('@weaveintel/tools');

  await page.screenshot({ path: 'test-results/phase6-docs.png', fullPage: false });
});

test('the login screen still renders with the brand intact', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Emerald brand token is live (proves the tokens engine/brand split from Phase 4 still serves).
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--gw-color-accent').trim(),
  );
  expect(accent).toBe('#0E9A6E');
});
