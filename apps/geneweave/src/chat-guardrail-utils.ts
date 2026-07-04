import type { ConditionNode, Guardrail, GuardrailStage } from '@weaveintel/core';
import type { GuardrailRow } from './db.js';

function parseTriggerFields(row: GuardrailRow): { triggerConditions?: ConditionNode | null; triggerDescription?: string } {
  let triggerConditions: ConditionNode | null = null;
  if (row.trigger_conditions) {
    try { triggerConditions = JSON.parse(row.trigger_conditions) as ConditionNode; } catch { /* ignore */ }
  }
  return {
    triggerConditions,
    ...(row.trigger_description != null ? { triggerDescription: row.trigger_description } : {}),
  };
}

/** Merges Phase 4 column values (judge_model, compliance_framework) into the config object. */
function injectPhase4Fields(config: Record<string, unknown>, row: GuardrailRow): Record<string, unknown> {
  if (!row.judge_model && !row.compliance_framework) return config;
  return {
    ...config,
    ...(row.judge_model ? { judge_model: row.judge_model } : {}),
    ...(row.compliance_framework ? { compliance_framework: row.compliance_framework } : {}),
  };
}

export function parseGuardrailConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function stageMatches(rowStage: string, stage: GuardrailStage): boolean {
  if (rowStage === 'both') return true;
  if (rowStage === 'pre' || rowStage === 'pre-execution') return stage === 'pre-execution';
  if (rowStage === 'post' || rowStage === 'post-execution') return stage === 'post-execution';
  return rowStage === stage;
}

export function normalizeGuardrailStage(rowStage: string, stage: GuardrailStage): GuardrailStage {
  if (rowStage === 'pre') return 'pre-execution';
  if (rowStage === 'post') return 'post-execution';
  if (rowStage === 'both') return stage;
  return rowStage as GuardrailStage;
}

export function inferRuleName(row: GuardrailRow, config: Record<string, unknown>): string | undefined {
  const explicit = typeof config['check'] === 'string' ? config['check'].trim().toLowerCase() : '';
  const source = explicit || `${row.id} ${row.name}`.toLowerCase();
  if (source.includes('pre') && source.includes('sycoph')) return 'input-pattern';
  if (source.includes('pre') && source.includes('confidence')) return 'risk-confidence-gate';
  if (source.includes('post') && source.includes('ground')) return 'grounding-overlap';
  if (source.includes('post') && source.includes('sycoph')) return 'output-pattern';
  if (source.includes('post') && (source.includes('devil') || source.includes('counterpoint'))) return 'decision-balance';
  if (source.includes('post') && source.includes('confidence')) return 'aggregate-confidence-gate';
  return undefined;
}

export function patternConfigFromNames(patterns: unknown): Record<string, unknown> {
  if (!Array.isArray(patterns)) return {};
  const library: Record<string, string> = {
    email: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
    phone: '\\+?\\d[\\d(). -]{7,}\\d',
    ssn: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    credit_card: '\\b(?:\\d[ -]*?){13,16}\\b',
  };
  const parts = patterns
    .map((value) => typeof value === 'string' ? library[value] : undefined)
    .filter((value): value is string => !!value);
  return parts.length ? { pattern: `(${parts.join('|')})`, action: 'warn' } : {};
}

export function normalizeGuardrail(row: GuardrailRow, stage: GuardrailStage): Guardrail {
  const config = injectPhase4Fields(parseGuardrailConfig(row.config), row);
  const normalizedStage = normalizeGuardrailStage(row.stage, stage);

  if (row.type === 'cognitive' || row.type === 'cognitive_check') {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: 'custom',
      stage: normalizedStage,
      enabled: !!row.enabled,
      priority: row.priority,
      config: {
        ...config,
        category: 'cognitive',
        rule: inferRuleName(row, config),
        pattern_target: typeof config['check'] === 'string' && String(config['check']).includes('post_') ? 'output' : 'input',
      },
      ...parseTriggerFields(row),
    };
  }

  if (row.type === 'factuality') {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: 'custom',
      stage: normalizedStage,
      enabled: !!row.enabled,
      priority: row.priority,
      config: {
        ...config,
        category: 'verification',
        rule: 'grounding-overlap',
        min_overlap: typeof config['confidence_threshold'] === 'number' ? Number(config['confidence_threshold']) / 10 : config['min_overlap'],
      },
      ...parseTriggerFields(row),
    };
  }

  if (row.type === 'budget') {
    const maxInputTokens = typeof config['max_input_tokens'] === 'number' ? Number(config['max_input_tokens']) : undefined;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: 'length',
      stage: normalizedStage,
      enabled: !!row.enabled,
      priority: row.priority,
      config: {
        ...config,
        maxLength: typeof config['maxLength'] === 'number' ? config['maxLength'] : maxInputTokens ? maxInputTokens * 4 : undefined,
        action: config['action'] === 'deny' || config['action'] === 'warn' ? config['action'] : 'warn',
      },
      ...parseTriggerFields(row),
    };
  }

  if (row.type === 'redaction' || row.type === 'pii_detection') {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: 'regex',
      stage: normalizedStage,
      enabled: !!row.enabled,
      priority: row.priority,
      config: {
        ...patternConfigFromNames(config['patterns']),
        ...config,
      },
      ...parseTriggerFields(row),
    };
  }

  if (row.type === 'content_filter') {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: 'blocklist',
      stage: normalizedStage,
      enabled: !!row.enabled,
      priority: row.priority,
      config: {
        ...config,
        words: Array.isArray(config['words']) ? config['words'] : Array.isArray(config['categories']) ? config['categories'] : [],
        action: config['action'] === 'deny' || config['action'] === 'warn' ? config['action'] : 'warn',
      },
      ...parseTriggerFields(row),
    };
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type as Guardrail['type'],
    stage: normalizedStage,
    enabled: !!row.enabled,
    config,
    priority: row.priority,
    ...parseTriggerFields(row),
  };
}
