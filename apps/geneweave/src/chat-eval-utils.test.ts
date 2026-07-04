import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from './db.js';

const redactMock = vi.fn();
const evalRunMock = vi.fn();

vi.mock('@weaveintel/guardrails/redaction', () => ({
  weaveRedactor: () => ({ redact: redactMock }),
}));

vi.mock('@weaveintel/testing/evals', () => ({
  weaveEvalRunner: () => ({ run: evalRunMock }),
}));

import { applyRedaction, runPostEval } from './chat-eval-utils.js';

describe('chat eval helper fail-safe behavior', () => {
  beforeEach(() => {
    redactMock.mockReset();
    evalRunMock.mockReset();
  });

  it('surfaces redaction engine failures explicitly', async () => {
    redactMock.mockRejectedValue(new Error('boom'));

    const result = await applyRedaction({} as any, 'secret', ['email']);

    expect(result.error).toBe('redaction_failed');
    // M-3 fix: on failure, original text is returned (not empty string)
    expect(result.redacted).toBe('secret');
    expect(result.wasModified).toBe(false);
  });

  it('surfaces post-eval failures explicitly', async () => {
    evalRunMock.mockRejectedValue(new Error('eval failed'));
    const db = {
      recordEval: vi.fn(),
    } as unknown as DatabaseAdapter;

    const result = await runPostEval(db, {} as any, 'user-1', 'chat-1', 'input', 'output', 10, 0.01, 'allow');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('post_eval_failed');
    }
  });
});
