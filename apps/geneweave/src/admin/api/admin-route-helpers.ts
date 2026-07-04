// SPDX-License-Identifier: MIT
import { normalizeCallableDescription, validateCallableDescription } from '@weaveintel/core';
import { stringifyPromptVariables } from '@weaveintel/prompts';
import type { DatabaseAdapter } from '../../db.js';

export function normalizePromptVariables(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      return stringifyPromptVariables(JSON.parse(trimmed));
    } catch {
      const names = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      return stringifyPromptVariables(names);
    }
  }

  return stringifyPromptVariables(input);
}

export function normalizeJsonField(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(trimmed.split(',').map((value) => value.trim()).filter(Boolean));
    }
  }
  return JSON.stringify(input);
}

export function parseJsonValue<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function validateDetailedDescription(
  description: unknown,
  kind: 'prompt' | 'tool' | 'skill' | 'agent',
): { valid: true; description: string } | { valid: false; error: string } {
  const normalized = normalizeCallableDescription(description);
  const validation = validateCallableDescription(normalized);
  if (!validation.valid) {
    return {
      valid: false,
      error: `${kind} description validation failed: ${validation.reasons.join('; ')}`,
    };
  }
  return { valid: true, description: normalized };
}

export async function clearDefaultPromptExcept(db: DatabaseAdapter, promptId: string): Promise<void> {
  const rows = await db.listPrompts();
  await Promise.all(
    rows
      .filter((r) => r.id !== promptId && r.is_default)
      .map((r) => db.updatePrompt(r.id, { is_default: 0 })),
  );
}

export function safeParsePromptVariables(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toDbUpdate<T>(fields: Record<string, unknown>): T {
  return fields as unknown as T;
}
