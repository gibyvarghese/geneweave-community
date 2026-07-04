/**
 * GeneWeave chat — system prompt resolution, capability telemetry snapshots
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import { createLogger } from '@weaveintel/core';
import type { CapabilityTelemetrySummary } from '@weaveintel/core';

const logger = createLogger('chat-system-prompt');
import {
  createPromptVersionFromRecord,
  executePromptRecord,
  resolveFragments,
  InMemoryFragmentRegistry,
  InMemoryPromptStrategyRegistry,
  fragmentFromRecord,
  strategyFromRecord,
  defaultPromptStrategyRegistry,
  resolvePromptRecordForExecution,
  createPromptCapabilityTelemetry,
  type PromptRecordExecutionResult,
} from '@weaveintel/prompts';
import type { ChatSettings } from './chat-runtime.js';
import type { DatabaseAdapter } from './db.js';

// ── Types ───────────────────────────────────────────────────

export interface PromptStrategyInfo {
  requestedKey: string;
  resolvedKey: string;
  usedFallback: boolean;
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedSystemPrompt {
  content?: string;
  strategy?: PromptStrategyInfo;
  telemetry?: CapabilityTelemetrySummary;
  resolution?: {
    source: 'base_prompt' | 'prompt_version';
    resolvedVersion: string;
    selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
    experimentId?: string;
    experimentVariantLabel?: string;
  };
}

// ── System prompt resolution ────────────────────────────────

export function toPromptStrategyInfo(result: PromptRecordExecutionResult): PromptStrategyInfo {
  return {
    requestedKey: result.strategy.requestedKey,
    resolvedKey: result.strategy.resolvedKey,
    usedFallback: result.strategy.usedFallback,
    name: result.strategy.name,
    description: result.strategy.description,
    metadata: result.strategy.metadata,
  };
}

/**
 * Resolve system prompt: if the settings reference a prompt by name/id,
 * look it up in the prompts table and render its template. Falls back to
 * the plain system_prompt string.
 */
export async function resolveSystemPrompt(
  db: DatabaseAdapter,
  settings: ChatSettings,
): Promise<ResolvedSystemPrompt> {
  if (!settings.systemPrompt) return { content: undefined };

  try {
    // Check if the system prompt references a DB prompt by name
    const rows = await db.listPrompts();
    const match = rows.find(
      r => r.enabled && (r.id === settings.systemPrompt || r.name === settings.systemPrompt),
    );
    if (match) {
      const versions = await db.listPromptVersions(match.id);
      const experiments = await db.listPromptExperiments(match.id);
      const resolved = resolvePromptRecordForExecution({
        prompt: match,
        versions,
        experiments,
        options: {
          assignmentKey: match.id,
        },
      });

      const vars: Record<string, unknown> = {};
      const promptVersion = createPromptVersionFromRecord(resolved.record);
      if ('variables' in promptVersion) {
        for (const variable of promptVersion.variables) {
          vars[variable.name] = variable.defaultValue ?? `[${variable.name}]`;
        }
      }

      // Build a fragment registry from enabled DB fragments, then pre-expand
      // {{>key}} inclusions in the template before passing to renderPromptRecord.
      let resolvedMatch = resolved.record;
      try {
        const fragmentRows = await db.listPromptFragments();
        const enabledFragments = fragmentRows.filter(f => f.enabled);
        if (enabledFragments.length > 0) {
          const fragmentRegistry = new InMemoryFragmentRegistry();
          for (const row of enabledFragments) {
            fragmentRegistry.register(fragmentFromRecord(row));
          }
          const baseTemplate = resolved.record.template ?? '';
          const expandedTemplate = resolveFragments(baseTemplate, fragmentRegistry);
          if (expandedTemplate !== baseTemplate) {
            resolvedMatch = { ...resolved.record, template: expandedTemplate };
          }
        }
      } catch {
        // Fragment expansion failure is non-fatal — fall through to raw template
      }

      // Build strategy registry from built-in shared strategies plus enabled DB-defined overlays.
      const strategyRegistry = new InMemoryPromptStrategyRegistry(defaultPromptStrategyRegistry.list());
      try {
        const strategyRows = await db.listPromptStrategies();
        for (const row of strategyRows) {
          if (!row.enabled) continue;
          strategyRegistry.register(strategyFromRecord(row));
        }
      } catch {
        // Strategy loading failure is non-fatal — fallback to built-ins only.
      }

      let promptTelemetry: CapabilityTelemetrySummary | undefined;
      const executed = executePromptRecord(resolvedMatch, vars, {
        strategyRegistry,
        evaluations: [
          {
            id: 'prompt_not_empty',
            description: 'Rendered system prompt should not be empty to avoid unbounded model behavior.',
            evaluate: ({ content }) => ({
              passed: content.trim().length > 0,
              score: content.trim().length > 0 ? 1 : 0,
              reason: content.trim().length > 0 ? undefined : 'Rendered prompt content is empty',
            }),
          },
        ],
        hooks: {
          onTelemetry: ({ telemetry }) => {
            promptTelemetry = telemetry;
          },
        },
      });

      const telemetry = promptTelemetry ?? createPromptCapabilityTelemetry(executed);

      return {
        content: executed.content,
        telemetry: {
          ...telemetry,
          source: 'db',
          selectedBy: resolved.meta.selectedBy,
          metadata: {
            ...(telemetry.metadata ?? {}),
            resolution: resolved.meta,
            expandedFromFragments: resolvedMatch.template !== resolved.record.template,
          },
        },
        strategy: toPromptStrategyInfo(executed),
        resolution: resolved.meta,
      };
    }
  } catch (err) {
    logger.warn('resolveSystemPrompt error — falling back to raw systemPrompt string', { err });
  }

  return { content: settings.systemPrompt };
}

// ── Capability telemetry snapshots ──────────────────────────

export function buildCapabilityTelemetrySnapshots(
  mode: string,
  promptTelemetry: CapabilityTelemetrySummary | undefined,
  activeSkills: Array<{ id: string; name: string; description: string; category: string; score: number; tools: string[] }>,
  enabledTools: string[],
): CapabilityTelemetrySummary[] {
  const snapshots: CapabilityTelemetrySummary[] = [];

  snapshots.push({
    kind: 'agent',
    key: `geneweave.${mode}`,
    name: mode === 'supervisor' ? 'GeneWeave Supervisor Agent' : mode === 'agent' ? 'GeneWeave Tool Agent' : 'GeneWeave Direct Runtime',
    description: mode === 'supervisor'
      ? 'Coordinates worker delegation, verification, and response synthesis using database-driven prompt, skill, and policy configuration.'
      : mode === 'agent'
      ? 'Runs a tool-calling agent loop with database-driven prompt, skill, and policy overlays.'
      : 'Runs direct model inference with shared prompt, guardrail, and observability integrations.',
    source: 'runtime',
    metadata: {
      mode,
      enabledToolCount: enabledTools.length,
      enabledTools,
    },
  });

  if (promptTelemetry) snapshots.push(promptTelemetry);

  for (const skill of activeSkills) {
    snapshots.push({
      kind: 'skill',
      key: skill.id,
      name: skill.name,
      description: skill.description,
      source: 'db',
      tags: [skill.category],
      metadata: {
        score: skill.score,
        tools: skill.tools,
      },
    });
  }

  return snapshots;
}
