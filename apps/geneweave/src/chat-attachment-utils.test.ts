/**
 * Tests for chat attachment utilities — CSV / file upload path.
 *
 * Covers:
 *  - normalizeAttachments: valid CSV, oversized, missing fields, audio stripping
 *  - buildAttachmentContext: CSV decode, non-text skipped, transcript fallback
 *  - composeUserInput: appends attachment block to message
 *  - hasTabularDataAttachments: mime type and extension detection
 *  - streamMessageImpl: socket timeout is disabled at entry
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeAttachments,
  buildAttachmentContext,
  composeUserInput,
  hasTabularDataAttachments,
} from './chat-attachment-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    name: 'data.csv',
    mimeType: 'text/csv',
    size: 100,
    dataBase64: b64('col1,col2\n1,2\n3,4'),
    ...overrides,
  };
}

// ── normalizeAttachments ──────────────────────────────────────────────────────

describe('normalizeAttachments', () => {
  it('returns empty array for undefined', () => {
    expect(normalizeAttachments(undefined)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(normalizeAttachments([])).toEqual([]);
  });

  it('passes a valid CSV attachment through', () => {
    const result = normalizeAttachments([makeAttachment()]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('data.csv');
    expect(result[0]!.mimeType).toBe('text/csv');
  });

  it('drops attachments missing name', () => {
    expect(normalizeAttachments([makeAttachment({ name: '' })])).toHaveLength(0);
  });

  it('drops attachments missing mimeType', () => {
    expect(normalizeAttachments([makeAttachment({ mimeType: '' })])).toHaveLength(0);
  });

  it('drops attachments with invalid base64', () => {
    expect(normalizeAttachments([makeAttachment({ dataBase64: 'not!!base64' })])).toHaveLength(0);
  });

  it('drops attachments that exceed the 4 MB size limit', () => {
    const oversized = makeAttachment({ size: 5 * 1024 * 1024, dataBase64: undefined });
    expect(normalizeAttachments([oversized])).toHaveLength(0);
  });

  it('caps the list at 8 attachments', () => {
    const items = Array.from({ length: 12 }, (_, i) => makeAttachment({ name: `f${i}.csv` }));
    expect(normalizeAttachments(items)).toHaveLength(8);
  });

  it('strips dataBase64 from audio attachments', () => {
    const audio = makeAttachment({ mimeType: 'audio/webm', dataBase64: b64('audiobytes') });
    const result = normalizeAttachments([audio]);
    expect(result[0]!.dataBase64).toBeUndefined();
  });

  it('sanitises path-traversal characters in filename', () => {
    const result = normalizeAttachments([makeAttachment({ name: '../../etc/passwd' })]);
    expect(result[0]!.name).not.toContain('..');
    expect(result[0]!.name).not.toContain('/');
  });
});

// ── buildAttachmentContext ────────────────────────────────────────────────────

describe('buildAttachmentContext', () => {
  it('decodes and includes CSV content', () => {
    const csv = 'month,revenue\nJan,1000\nFeb,1200';
    const ctx = buildAttachmentContext([makeAttachment({ dataBase64: b64(csv) })]);
    expect(ctx).toContain('month,revenue');
    expect(ctx).toContain('Jan,1000');
  });

  it('uses transcript when present (skips base64 decode)', () => {
    const a = makeAttachment({
      transcript: 'pre-computed transcript',
      dataBase64: b64('should not appear'),
    });
    const ctx = buildAttachmentContext([a]);
    expect(ctx).toContain('pre-computed transcript');
    expect(ctx).not.toContain('should not appear');
  });

  it('does not include base64 content for binary mime types', () => {
    const png = makeAttachment({ mimeType: 'image/png', name: 'chart.png', dataBase64: b64('pngbytes') });
    const ctx = buildAttachmentContext([png]);
    expect(ctx).not.toContain('pngbytes');
    expect(ctx).toContain('chart.png');
  });

  it('includes application/csv as text', () => {
    const csv = 'a,b\n1,2';
    const a = makeAttachment({ mimeType: 'application/csv', dataBase64: b64(csv) });
    const ctx = buildAttachmentContext([a]);
    expect(ctx).toContain('a,b');
  });

  it('truncates very large content to maxInlineChars', () => {
    const huge = 'x'.repeat(20_000);
    const a = makeAttachment({ mimeType: 'text/plain', name: 'big.txt', dataBase64: b64(huge) });
    const ctx = buildAttachmentContext([a], { maxInlineChars: 100 });
    // 100 chars of content + surrounding lines — total context must be < 200 chars
    expect(ctx.length).toBeLessThan(200);
  });
});

// ── composeUserInput ──────────────────────────────────────────────────────────

describe('composeUserInput', () => {
  it('returns plain content when no attachments', () => {
    expect(composeUserInput('hello', [])).toBe('hello');
  });

  it('appends [User attachments] block for CSV', () => {
    const csv = 'a,b\n1,2';
    const composed = composeUserInput(
      'analyse this csv file and give insights',
      [makeAttachment({ dataBase64: b64(csv) })],
    );
    expect(composed).toContain('analyse this csv file');
    expect(composed).toContain('[User attachments]');
    expect(composed).toContain('a,b');
  });

  it('works with empty message content (attachment-only message)', () => {
    const composed = composeUserInput('', [makeAttachment()]);
    expect(composed).toContain('[User attachments]');
  });
});

// ── hasTabularDataAttachments ─────────────────────────────────────────────────

describe('hasTabularDataAttachments', () => {
  it('returns false for empty array', () => {
    expect(hasTabularDataAttachments([])).toBe(false);
  });

  it('detects text/csv mime type', () => {
    expect(hasTabularDataAttachments([makeAttachment({ mimeType: 'text/csv' })])).toBe(true);
  });

  it('detects application/csv mime type', () => {
    expect(hasTabularDataAttachments([makeAttachment({ mimeType: 'application/csv' })])).toBe(true);
  });

  it('detects .csv filename extension', () => {
    expect(hasTabularDataAttachments([makeAttachment({ mimeType: 'application/octet-stream', name: 'export.csv' })])).toBe(true);
  });

  it('detects .xlsx filename extension', () => {
    expect(hasTabularDataAttachments([makeAttachment({ mimeType: 'application/octet-stream', name: 'report.xlsx' })])).toBe(true);
  });

  it('returns false for non-tabular types', () => {
    expect(hasTabularDataAttachments([makeAttachment({ mimeType: 'image/png', name: 'photo.png' })])).toBe(false);
  });
});

// ── streamMessageImpl socket timeout ─────────────────────────────────────────

describe('streamMessageImpl — socket timeout disabled for SSE', () => {
  it('calls socket.setTimeout(0) at entry to prevent 30s server timeout killing CSV analysis', async () => {
    // Dynamically import to pick up the real module after test setup
    const { streamMessageImpl } = await import('./chat-stream-message.js');

    const setTimeoutMock = vi.fn();
    const mockRes = {
      socket: { setTimeout: setTimeoutMock },
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };

    // Minimal deps — guardrail check will short-circuit via pre-guardrail deny
    // so we never need a real model. We just need to reach the socket.setTimeout call.
    const deps = {
      config: {
        defaultProvider: 'mock',
        defaultModel: 'mock',
        providers: {},
        jwtSecret: 'x',
        corsOrigin: undefined,
        publicBaseUrl: undefined,
      },
      db: {
        getChat: vi.fn().mockResolvedValue(null),
        getChatSettings: vi.fn().mockResolvedValue(null),
        getUserById: vi.fn().mockResolvedValue({ id: 'u1', persona: 'user', tenant_id: null }),
        getMessages: vi.fn().mockResolvedValue([]),
        listEnabledGuardrails: vi.fn().mockResolvedValue([]),
        getRoutingPolicyForModel: vi.fn().mockResolvedValue(null),
        getToolPolicyByKey: vi.fn().mockResolvedValue(null),
        getSkillsByIds: vi.fn().mockResolvedValue([]),
        listMemories: vi.fn().mockResolvedValue([]),
        upsertMemory: vi.fn().mockResolvedValue(undefined),
        listProceduralInstructions: vi.fn().mockResolvedValue([]),
        getChatContextSummary: vi.fn().mockResolvedValue(null),
        listWorkingMemoryEntries: vi.fn().mockResolvedValue([]),
        getPromptContract: vi.fn().mockResolvedValue(null),
        createMessage: vi.fn().mockResolvedValue(undefined),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        upsertChatContextSummary: vi.fn().mockResolvedValue(undefined),
        getCachePolicy: vi.fn().mockResolvedValue(null),
        getRedactionPolicy: vi.fn().mockResolvedValue(null),
        listTenantThemes: vi.fn().mockResolvedValue([]),
        listCostPolicies: vi.fn().mockResolvedValue([]),
        getModelSetting: vi.fn().mockResolvedValue(null),
        listEnabledSkills: vi.fn().mockResolvedValue([]),
        getGlobalPromptConfig: vi.fn().mockResolvedValue(null),
      } as any,
      healthTracker: {
        listHealth: vi.fn().mockReturnValue([]),
        getBlockedProviders: vi.fn().mockReturnValue(new Set()),
        blockProvider: vi.fn(),
        recordOutcome: vi.fn(),
      },
      responseCache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
      cacheKeyBuilder: { build: vi.fn().mockReturnValue('gw-chat:v1:streamkey') },
      getAvailableModels: vi.fn().mockResolvedValue([]),
      withResponseCardFormatPolicy: vi.fn().mockResolvedValue(undefined),
      streamAgent: vi.fn().mockResolvedValue({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs: 0, steps: [] }),
      writeSseEvent: vi.fn().mockResolvedValue(true),
      endSse: vi.fn(),
      loadPricing: vi.fn().mockResolvedValue(new Map()),
      recordModelOutcome: vi.fn(),
      safeParseJson: vi.fn().mockReturnValue(null),
    };

    // Run — it will fail past the socket call but that's fine; we only care that
    // setTimeout(0) was called at function entry before any error path.
    await streamMessageImpl(deps, mockRes as any, 'u1', 'chat1', 'analyse this CSV').catch(() => {});

    expect(setTimeoutMock).toHaveBeenCalledWith(0);
  });
});
