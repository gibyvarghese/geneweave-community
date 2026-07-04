import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from './db.js';
import { evaluateGuardrails } from './chat-guardrail-eval-utils.js';

describe('chat guardrail fail-safe behavior', () => {
  it('denies pre-execution when guardrail evaluation fails', async () => {
    const db = {
      listGuardrails: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as DatabaseAdapter;

    const result = await evaluateGuardrails(db, 'chat-1', null, 'hello', 'pre-execution');

    expect(result.decision).toBe('deny');
    expect(result.error).toBe('guardrail_evaluation_failed');
    expect(result.reason).toContain('blocked');
  });

  it('warns post-execution when guardrail evaluation fails', async () => {
    const db = {
      listGuardrails: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as DatabaseAdapter;

    const result = await evaluateGuardrails(db, 'chat-1', null, 'hello', 'post-execution');

    expect(result.decision).toBe('warn');
    expect(result.error).toBe('guardrail_evaluation_failed');
    expect(result.reason).toContain('unverified');
  });
});
