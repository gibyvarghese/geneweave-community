/**
 * Realtime voice pipeline — live Playwright E2E
 *
 * Tests the actual browser → server WS → OpenAI Realtime flow.
 * Requires OPENAI_API_KEY in .env with GA Realtime API access.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const EMAIL    = 'realtime-live@weaveintel.dev';

async function loginOrRegister(page: Page) {
  await page.goto('/');
  if (await page.locator('.workspace-nav').isVisible({ timeout: 2_000 }).catch(() => false)) return;

  let res = await page.request.post('/api/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', {
      data: { name: 'Realtime Live', email: EMAIL, password: PASSWORD },
    });
    res = await page.request.post('/api/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });
}

async function getCsrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

async function apiSaveConfig(page: Page, patch: Record<string, unknown>) {
  const csrf = await getCsrf(page);
  const r = await page.request.post('/api/voice/config', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: patch,
  });
  expect(r.status()).toBe(200);
}

// ── Shared WS helper (browser-side) ──────────────────────────────────────────

/**
 * Opens a realtime WS from within the browser page, drives the barge-in
 * protocol, and returns a structured result for assertions.
 */
async function runRealtimeBargeIn(page: Page, sessionId: string) {
  return page.evaluate(async (sid: string) => {
    interface WsMsg { type: string; [k: string]: unknown }

    const timeline: { ms: number; event: WsMsg | string }[] = [];
    const t0 = performance.now();

    function record(event: WsMsg | string) {
      timeline.push({ ms: Math.round(performance.now() - t0), event });
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws    = new WebSocket(`${proto}//${location.host}/api/voice/sessions/${sid}/realtime`);

    let bargeInAck: WsMsg | null = null;
    let firstAudioItemId: string | null = null;
    let audioStartedMs: number | null = null;
    let bargeInSentMs: number | null = null;
    let bargeInAckMs: number | null = null;

    const wsOpen  = new Promise<void>((res) => { ws.onopen  = () => res(); });
    const wsReady = new Promise<void>((res) => {
      const orig = ws.onmessage;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as WsMsg;
        if (msg.type === 'realtime_ready') res();
        ws.onmessage = orig;
      };
    });

    await wsOpen;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WsMsg;
      record(msg);

      if (msg.type === 'audio' && !msg['done'] && !firstAudioItemId) {
        firstAudioItemId = (msg['itemId'] as string) ?? null;
        audioStartedMs  = Math.round(performance.now() - t0);
      }
      if (msg.type === 'barge_in_ack') {
        bargeInAck   = msg;
        bargeInAckMs = Math.round(performance.now() - t0);
      }
    };

    // 1. Wait for proxy to connect to OpenAI
    await wsReady;
    record('realtime_ready');

    // 2. Send a text turn to trigger a long audio response
    ws.send(JSON.stringify({
      type: 'text',
      text: 'Count slowly from one to one hundred, saying each number as a full word.',
    }));

    // 3. Wait for first audio delta (up to 20s for TTFA)
    const audioTimeout = new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error('Timeout waiting for audio delta')), 20_000));
    await Promise.race([
      new Promise<void>((res) => {
        const check = setInterval(() => {
          if (firstAudioItemId !== null) { clearInterval(check); res(); }
        }, 50);
      }),
      audioTimeout,
    ]);

    // 4. Let 300ms of audio accumulate then fire barge-in
    await new Promise<void>((r) => setTimeout(r, 300));
    const audioPlayedMs = 250; // simulated playback position
    bargeInSentMs = Math.round(performance.now() - t0);
    ws.send(JSON.stringify({
      type: 'barge_in',
      itemId: firstAudioItemId ?? '',
      audioPlayedMs,
    }));

    // 5. Wait for barge_in_ack (up to 1s)
    await Promise.race([
      new Promise<void>((res) => {
        const check = setInterval(() => {
          if (bargeInAck !== null) { clearInterval(check); res(); }
        }, 10);
      }),
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error('Timeout waiting for barge_in_ack')), 1_000)),
    ]);

    // 6. Check session stays alive for another 500ms
    await new Promise<void>((r) => setTimeout(r, 500));
    const wsStillOpen = ws.readyState === WebSocket.OPEN;

    ws.close();

    return {
      timeline,
      firstAudioItemId,
      audioStartedMs,
      bargeInSentMs,
      bargeInAckMs,
      bargeInAck,
      audioPlayedMs,
      wsStillOpen,
    };
  }, sessionId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Realtime voice — live connection', () => {

  test('proxy connects to OpenAI GA Realtime and gets realtime_ready', async ({ page }) => {
    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    // Create a voice session
    const csrf = await getCsrf(page);
    const sessionRes = await page.request.post('/api/voice/sessions', {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: {},
    });
    expect(sessionRes.status()).toBe(201);
    const { sessionId } = await sessionRes.json() as { sessionId: string };

    // Connect to the REALTIME endpoint from within the browser (cookies are sent automatically)
    const messages: string[] = await page.evaluate((sid: string) => {
      return new Promise<string[]>((resolve) => {
        const msgs: string[] = [];
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/api/voice/sessions/${sid}/realtime`);
        ws.onmessage = (ev) => { msgs.push(ev.data as string); };
        ws.onerror   = ()   => { msgs.push('__ws_error__'); };
        ws.onclose   = (ev) => { msgs.push(`__ws_close_${ev.code}__`); };
        // Wait up to 6 seconds for OpenAI to respond
        setTimeout(() => { ws.close(); resolve(msgs); }, 6000);
      });
    }, sessionId);

    const parsed = messages.map((m) => {
      try { return JSON.parse(m) as Record<string, unknown>; }
      catch { return { type: m }; }
    });

    console.log('[realtime-live] Events received:', parsed.map((e) => e['type']));

    // Log any errors with full detail for diagnosis
    const errors = parsed.filter((e) => e['type'] === 'error');
    if (errors.length) {
      console.log('[realtime-live] Error details:', JSON.stringify(errors, null, 2));
    }

    // If we got fallbackToChained it means OpenAI rejected — surface the message
    const fallback = parsed.find((e) => e['fallbackToChained']);
    if (fallback) {
      throw new Error(`OpenAI Realtime rejected connection: ${fallback['message'] as string}`);
    }

    // The proxy must forward realtime_ready (sent after OpenAI session.created + session.updated)
    expect(parsed.map((e) => e['type'])).toContain('realtime_ready');

    await page.request.delete(`/api/voice/sessions/${sessionId}`, {
      headers: { 'X-CSRF-Token': csrf },
    });
  });

  test('mic button shows voice bar and stays visible in realtime mode', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);

    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    await page.reload();
    await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });

    // Intercept browser console to capture voice-agent log lines
    const consoleLogs: string[] = [];
    page.on('console', (msg) => { consoleLogs.push(`[${msg.type()}] ${msg.text()}`); });
    page.on('pageerror', (err) => { consoleLogs.push(`[pageerror] ${err.message}`); });

    const micBtn = page.locator('.voice-agent-btn');
    await expect(micBtn).toBeVisible({ timeout: 5_000 });
    await micBtn.click();

    await expect(page.locator('.voice-bar')).toBeVisible({ timeout: 10_000 });

    // Poll status every 500ms for 12 seconds so we can see when/if it disappears
    const snapshots: { ms: number; visible: boolean; label: string }[] = [];
    const startMs = Date.now();
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      const visible = await page.locator('.voice-bar').isVisible().catch(() => false);
      const label   = await page.locator('#va-label').textContent().catch(() => '');
      snapshots.push({ ms: Date.now() - startMs, visible, label: label?.trim() ?? '' });
      if (!visible) break; // stop early if it disappeared
    }

    console.log('[realtime-live] Voice bar timeline:');
    snapshots.forEach((s) => console.log(`  ${s.ms}ms: visible=${s.visible} status="${s.label}"`));
    if (consoleLogs.length) {
      console.log('[realtime-live] Browser console:', consoleLogs.slice(-20).join('\n'));
    }

    await page.screenshot({ path: 'test-results/realtime-mic-state.png', fullPage: false });

    const lastSnapshot = snapshots.at(-1)!;
    expect(lastSnapshot.visible, `Voice bar disappeared at ${lastSnapshot.ms}ms with status "${lastSnapshot.label}"`).toBe(true);
  });

  test('barge-in: client barge_in → barge_in_ack received with correct audioEndMs', async ({ page }) => {
    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    const csrf = await getCsrf(page);
    const sessionRes = await page.request.post('/api/voice/sessions', {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: {},
    });
    expect(sessionRes.status()).toBe(201);
    const { sessionId } = await sessionRes.json() as { sessionId: string };

    let result: Awaited<ReturnType<typeof runRealtimeBargeIn>>;
    try {
      result = await runRealtimeBargeIn(page, sessionId);
    } finally {
      await page.request.delete(`/api/voice/sessions/${sessionId}`, {
        headers: { 'X-CSRF-Token': csrf },
      });
    }

    console.log('[barge-in] Timeline:');
    result.timeline.forEach(({ ms, event }) => {
      const type = typeof event === 'string' ? event : (event as { type: string }).type;
      console.log(`  ${ms}ms: ${type}`);
    });
    console.log(`[barge-in] First audio TTFA: ${result.audioStartedMs}ms`);
    console.log(`[barge-in] Barge-in sent at: ${result.bargeInSentMs}ms`);
    console.log(`[barge-in] Barge-in ack at:  ${result.bargeInAckMs}ms`);

    // ── Assertions ──────────────────────────────────────────────────────────

    // 1. First audio delta arrived (OpenAI is streaming)
    expect(result.firstAudioItemId, 'First audio item_id should not be null').toBeTruthy();

    // 2. barge_in_ack received
    expect(result.bargeInAck, 'barge_in_ack not received').not.toBeNull();
    expect((result.bargeInAck as unknown as Record<string, unknown>)['type']).toBe('barge_in_ack');

    // 3. audioEndMs echoes what we sent (250ms)
    expect((result.bargeInAck as unknown as Record<string, unknown>)['audioEndMs']).toBe(result.audioPlayedMs);

    // 4. Round-trip latency: barge_in sent → barge_in_ack < 800ms
    const roundTripMs = (result.bargeInAckMs ?? 9999) - (result.bargeInSentMs ?? 0);
    console.log(`[barge-in] Round-trip latency: ${roundTripMs}ms (target <800ms)`);
    expect(roundTripMs, `Barge-in round-trip too slow: ${roundTripMs}ms`).toBeLessThan(800);

    // 5. Session stayed alive after barge-in (the regression check)
    expect(result.wsStillOpen, 'WS closed after barge-in — voice bar would have disappeared').toBe(true);
  });

  test('barge-in: voice bar stays visible throughout barge-in cycle', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    await page.reload();
    await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });

    const consoleLogs: string[] = [];
    page.on('console', (msg) => { consoleLogs.push(`[${msg.type()}] ${msg.text()}`); });

    await page.locator('.voice-agent-btn').click();
    await expect(page.locator('.voice-bar')).toBeVisible({ timeout: 10_000 });

    // Poll voice bar visibility for 15 seconds (enough time for a barge-in cycle)
    const snapshots: { ms: number; visible: boolean; label: string }[] = [];
    const startMs = Date.now();
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      const visible = await page.locator('.voice-bar').isVisible().catch(() => false);
      const label   = await page.locator('#va-label').textContent().catch(() => '');
      snapshots.push({ ms: Date.now() - startMs, visible, label: label?.trim() ?? '' });
      if (!visible) break;
    }

    console.log('[barge-in-ui] Voice bar timeline:');
    snapshots.forEach((s) => console.log(`  ${s.ms}ms: visible=${s.visible} status="${s.label}"`));
    if (consoleLogs.length) {
      console.log('[barge-in-ui] Console:', consoleLogs.slice(-20).join('\n'));
    }

    await page.screenshot({ path: 'test-results/realtime-barge-in-state.png' });

    const lastSnapshot = snapshots.at(-1)!;
    expect(lastSnapshot.visible, `Voice bar disappeared at ${lastSnapshot.ms}ms`).toBe(true);
  });

});
