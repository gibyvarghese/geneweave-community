/**
 * Reasoning settings — m92 columns + saveChatSettings/getChatSettings round-trip
 * + settingsFromRow mapping. Positive, negative, security.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { settingsFromRow } from './chat-runtime.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-reasoning-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('reasoning settings — DB round-trip', () => {
  let db: SQLiteAdapter;
  async function mkChat(id: string): Promise<void> {
    await db.createChat({ id, userId: 'u1', title: 't', model: 'gpt-4o-mini', provider: 'openai' });
  }
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
  });
  afterEach(async () => { await db.close(); });

  it('seeds supports_thinking=1 for reasoning-capable Claude models (capability gate)', async () => {
    for (const modelId of ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001']) {
      const caps = await db.listCapabilityScores({ provider: 'anthropic', modelId });
      expect(caps.length, `${modelId} should have capability rows`).toBeGreaterThan(0);
      expect(caps.some((c) => c.supports_thinking === 1), `${modelId} should be thinking-capable`).toBe(true);
    }
    // A non-thinking model stays gated.
    const mini = await db.listCapabilityScores({ provider: 'openai', modelId: 'gpt-4o-mini' });
    expect(mini.some((c) => c.supports_thinking === 1)).toBe(false);
  });

  it('m92 columns exist and default to off (negative/default)', async () => {
    await mkChat('c-default');
    await db.saveChatSettings({ chatId: 'c-default', mode: 'direct' });
    const row = await db.getChatSettings('c-default');
    expect(row).toBeTruthy();
    expect(row!.reasoning_enabled).toBe(0);
    expect(row!.reasoning_effort).toBeNull();
    expect(row!.reasoning_budget_tokens).toBe(0);
    const settings = settingsFromRow(row);
    expect(settings.reasoningEnabled).toBe(false);
    expect(settings.reasoningEffort).toBeUndefined();
  });

  it('persists + reflects reasoning settings (positive)', async () => {
    await mkChat('c1');
    await db.saveChatSettings({ chatId: 'c1', mode: 'agent', reasoningEnabled: true, reasoningEffort: 'high', reasoningBudgetTokens: 3000 });
    const row = await db.getChatSettings('c1');
    expect(row!.reasoning_enabled).toBe(1);
    expect(row!.reasoning_effort).toBe('high');
    expect(row!.reasoning_budget_tokens).toBe(3000);
    const settings = settingsFromRow(row);
    expect(settings.reasoningEnabled).toBe(true);
    expect(settings.reasoningEffort).toBe('high');
    expect(settings.reasoningBudgetTokens).toBe(3000);
  });

  it('an upsert that omits reasoning resets it to off (idempotent settings semantics)', async () => {
    await mkChat('c2');
    await db.saveChatSettings({ chatId: 'c2', mode: 'agent', reasoningEnabled: true, reasoningEffort: 'low' });
    await db.saveChatSettings({ chatId: 'c2', mode: 'agent' }); // mode-only upsert
    const row = await db.getChatSettings('c2');
    expect(row!.reasoning_enabled).toBe(0);
  });

  it('settingsFromRow rejects an out-of-range effort string (security/robustness)', async () => {
    await mkChat('c3');
    await db.saveChatSettings({ chatId: 'c3', mode: 'agent', reasoningEnabled: true });
    // Corrupt the stored effort directly.
    db.getRawDb().prepare(`UPDATE chat_settings SET reasoning_effort = 'turbo' WHERE chat_id = 'c3'`).run();
    const settings = settingsFromRow(await db.getChatSettings('c3'));
    expect(settings.reasoningEffort).toBeUndefined(); // invalid value dropped
    expect(settings.reasoningEnabled).toBe(true);
  });
});
