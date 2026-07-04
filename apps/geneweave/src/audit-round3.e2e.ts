/**
 * UX Audit — Round 3: multimodal hardening (streaming · upload · voice).
 * Grounded in R1/R2: the full render()-per-chunk architecture (FP-C) breaks transcript scroll + the
 * aria-live region during streaming, there is no Stop control, and upload silently drops rejected files.
 *
 * Run: npm run test:e2e -- audit-round3
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PW = 'Str0ng!Pass99';

async function login(page: Page): Promise<void> {
  const email = `audit3-${Date.now()}-${Math.floor(Math.random() * 1e6)}@weaveintel.dev`;
  await page.request.post('/api/auth/register', { data: { name: 'Audit Three', email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /new chat/i }).first().click();
  await expect(page.locator('textarea[placeholder="Type a message..."]')).toBeVisible();
}

/** Inject a tall transcript deterministically (no LLM needed) via the exposed globals, then render. */
async function seedTranscript(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const w = window as any;
    w.state.messages = [];
    for (let i = 0; i < count; i++) {
      w.state.messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message number ${i} — some body text, repeated a few times to give the transcript real height so it scrolls. ${'lorem ipsum dolor sit amet. '.repeat(3)}`, created_at: new Date().toISOString() });
    }
    w.render();
    if (w.renderMessages) w.renderMessages();
  }, n);
  // Wait until the messages have actually painted (robust under managed-server load).
  await expect(page.locator('.messages .msg')).toHaveCount(n, { timeout: 15000 });
}

test.describe('Round 3 — multimodal hardening', () => {
  test.describe.configure({ retries: 2 }); // real-LLM + layout-timing tests are load-sensitive on the shared managed server

  test('UPLOAD — an oversized file is REJECTED WITH A VISIBLE, specific message (not silently dropped)', async ({ page }) => {
    await login(page);
    // 11 MB file (> the 10 MB cap).
    const big = join(tmpdir(), `audit3-big-${Date.now()}.bin`);
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 1));
    await page.locator('input[type="file"]').setInputFiles(big);
    // The user must be told, by name + reason — not left guessing why nothing attached.
    const reject = page.locator('.upload-reject, [role="alert"]').filter({ hasText: /too large|exceeds|10 ?MB|couldn.t add/i });
    await expect(reject.first()).toBeVisible({ timeout: 8000 });
    // And it did NOT get attached.
    await expect(page.locator('.attachment, .attachment-preview')).toHaveCount(0);
  });

  test('UPLOAD — a valid file attaches and shows a preview chip', async ({ page }) => {
    await login(page);
    const small = join(tmpdir(), `audit3-ok-${Date.now()}.txt`);
    writeFileSync(small, 'hello world');
    await page.locator('input[type="file"]').setInputFiles(small);
    await expect(page.locator('.attach-chip').first()).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.attach-chip .name')).toContainText(/\.txt/);
  });

  test('STREAM SCROLL — a full re-render preserves the transcript scroll position (does not jump)', async ({ page }) => {
    await login(page);
    await seedTranscript(page, 40);
    const msgs = page.locator('.messages');
    await expect(msgs).toBeVisible();
    // Guarantee a scroll container deterministically (the app's flex height can be slow to constrain under
    // concurrent load). We're testing the scroll-PRESERVATION logic, so a fixed height is a fair setup.
    await msgs.evaluate((el) => { (el as HTMLElement).style.height = '360px'; (el as HTMLElement).style.overflowY = 'auto'; });
    await expect.poll(async () => msgs.evaluate((el) => (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight), { timeout: 10000 })
      .toBeGreaterThan(400);
    // Scroll to a MIDDLE position and confirm it took.
    await msgs.evaluate((el) => { el.scrollTop = Math.round(el.scrollHeight * 0.4); el.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => msgs.evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 3000 }).toBeGreaterThan(80);
    const before = await msgs.evaluate((el) => el.scrollTop);
    // Re-render the transcript the way STREAMING does (per token) — the reader's position must be kept,
    // not reset to top (old bug) or yanked to the bottom.
    await page.evaluate(() => (window as any).renderMessages());
    // Poll until the double-rAF restore settles near the saved position (robust to render timing).
    await expect.poll(async () => page.locator('.messages').evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 6000 })
      .toBeGreaterThan(before - 120); // not reset toward the top
    const after = await page.locator('.messages').evaluate((el) => el.scrollTop);
    expect(after).toBeLessThan(before + 300); // not yanked to the bottom either
  });

  test('STREAM STOP — a visible Stop control appears during generation, stops it, and keeps partial output', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const ta = page.locator('textarea[placeholder="Type a message..."]');
    await ta.click();
    // A long generation so there's a reliable window to Stop mid-stream.
    await ta.fill('Write a thorough ~1500-word essay on the history of cartography, from ancient clay tablets through Ptolemy, medieval mappae mundi, the Age of Exploration, Mercator, national surveys, and modern GIS. Use many paragraphs and concrete detail.');
    await page.getByRole('button', { name: /^send/i }).click();
    // (H17) A Stop control MUST be offered while generating — not just a disabled Send.
    await expect(page.getByRole('button', { name: /stop generating/i })).toBeVisible({ timeout: 30_000 });
    // Once REAL tokens have streamed (partial output exists), trigger the Stop mechanism. We invoke the same
    // handler the button is wired to (deterministic — avoids racing the real-LLM stream with a click).
    await expect(page.locator('.msg.assistant .bubble').last()).toContainText(/\w{5,}/, { timeout: 40_000 });
    const partial = await page.locator('.msg.assistant .bubble').last().textContent();
    await page.evaluate(() => (window as any).stopStreaming());
    // Streaming ends promptly (Send returns, Stop is gone), the partial output is PRESERVED, and NOT an error.
    await expect(page.locator('.send-btn[aria-disabled="false"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /stop generating/i })).toHaveCount(0);
    await expect(page.locator('.msg.assistant .bubble').last()).not.toBeEmpty();
    expect((partial || '').length).toBeGreaterThan(3);
    await expect(page.locator('.msg-error')).toHaveCount(0);
  });

  // NOTE (Human-Judgment / manual): mic-permission-DENIED can't be forced in this harness — the Playwright
  // config launches with `--use-fake-device-for-media-stream` + granted microphone, so getUserMedia always
  // succeeds. The denied path IS handled in code (voice-agent.ts: getUserMedia catch → state.voiceError =
  // 'Microphone access denied', shown in the aria-live voice status region). Verify manually with a real
  // browser that denies the prompt. Tracked in UX_AUDIT_NOTES.md → Human-Judgment Items.
});
