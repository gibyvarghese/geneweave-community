/**
 * GeneWeave chat — skills discovery helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import type { Model, ExecutionContext } from '@weaveintel/core';
import {
  activateSkills,
  collectSkillTools,
  createSkillRegistry,
  skillFromRow,
  type SkillMatch,
} from '@weaveintel/skills';
import type { DatabaseAdapter } from './db.js';
import type { ChatScopeGuard } from './chat-scope-guard.js';
import type { ScopeContext } from '@weaveintel/identity/scope';

// ── Private helper ──────────────────────────────────────────

function normalizeText(raw: string | undefined): string {
  return (raw ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(raw: string | undefined): string[] {
  const normalized = normalizeText(raw);
  if (!normalized) return [];
  const stop = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);
  return normalized
    .split(' ')
    .filter((token) => token.length > 2 && !stop.has(token));
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
  return out;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const val of a.values()) normA += val * val;
  for (const val of b.values()) normB += val * val;
  if (normA === 0 || normB === 0) return 0;

  for (const [term, aval] of a.entries()) {
    dot += aval * (b.get(term) ?? 0);
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function semanticIntentScore(query: string, corpus: string): number {
  const q = termFrequency(tokenize(query));
  const c = termFrequency(tokenize(corpus));
  return cosineSimilarity(q, c);
}

// Tag-driven routing markers. Skills opt into these behaviors via their `tags`
// array (DB column `tags`, JSON string[]). No skill IDs are hardcoded.
//   - 'auto-on-tabular'        : auto-include this skill when a tabular
//                                attachment is present.
//   - 'requires-intent-match'  : drop this skill from selection when the
//                                semantic match between the query and the
//                                skill's own corpus (triggerPatterns +
//                                description + tags) is below the threshold.
const TAG_AUTO_ON_TABULAR = 'auto-on-tabular';
const TAG_REQUIRES_INTENT_MATCH = 'requires-intent-match';
const INTENT_MATCH_THRESHOLD = 0.14;

function skillIntentCorpus(skill: SkillMatch['skill']): string {
  const parts: string[] = [];
  if (skill.description) parts.push(skill.description);
  if (skill.summary) parts.push(skill.summary);
  if (Array.isArray(skill.triggerPatterns)) parts.push(skill.triggerPatterns.join(' '));
  if (Array.isArray(skill.tags)) parts.push(skill.tags.join(' '));
  return parts.join(' ');
}

function hasTag(skill: SkillMatch['skill'], tag: string): boolean {
  return Array.isArray(skill.tags) && skill.tags.includes(tag);
}

function applyTagBasedRouting(
  query: string,
  candidates: readonly SkillMatch[],
  selectedSkillIds: readonly string[],
  hasTabularAttachment: boolean,
): string[] {
  const candidateById = new Map(candidates.map((c) => [c.skill.id, c]));
  let selected = [...selectedSkillIds];

  // Auto-include any candidate tagged for tabular auto-activation.
  if (hasTabularAttachment) {
    for (const candidate of candidates) {
      if (hasTag(candidate.skill, TAG_AUTO_ON_TABULAR) && !selected.includes(candidate.skill.id)) {
        selected.unshift(candidate.skill.id);
      }
    }
  }

  // Drop selected skills tagged 'requires-intent-match' when the query does
  // not semantically match the skill's own corpus.
  selected = selected.filter((id) => {
    const candidate = candidateById.get(id);
    if (!candidate) return true;
    if (!hasTag(candidate.skill, TAG_REQUIRES_INTENT_MATCH)) return true;
    const score = semanticIntentScore(query, skillIntentCorpus(candidate.skill));
    return score >= INTENT_MATCH_THRESHOLD;
  });

  return selected.slice(0, 3);
}

async function reasonAboutSkillSelection(
  model: Model,
  ctx: ExecutionContext,
  query: string,
  mode: string,
  candidates: readonly SkillMatch[],
  parseJson: (text: string) => unknown,
  hasTabularAttachment: boolean,
): Promise<{ selectedSkillIds: string[]; rationale?: string; useNoSkillPath?: boolean } | null> {
  if (candidates.length <= 1) {
    return {
      selectedSkillIds: candidates.map((candidate) => candidate.skill.id),
      rationale: 'Only one semantic candidate available.',
    };
  }

  const compactCandidates = candidates.map((candidate, index) => ({
    rank: index + 1,
    id: candidate.skill.id,
    name: candidate.skill.name,
    score: Number(candidate.score.toFixed(3)),
    summary: candidate.skill.summary,
    whenToUse: candidate.skill.whenToUse,
    whenNotToUse: candidate.skill.whenNotToUse,
    policy: candidate.skill.policy,
  }));

  const selectionPrompt = [
    'Select the best skills for this request from the candidate list.',
    'Prioritize semantic fit, completion quality, and policy-safe execution.',
    'You may choose 0..3 skills. Choose zero if none fit.',
    'Respond ONLY as JSON with shape: {"selectedSkillIds": string[], "useNoSkillPath": boolean, "rationale": string }.',
    '',
    `Invocation mode: ${mode}`,
    `User request: ${query}`,
    `Candidates: ${JSON.stringify(compactCandidates)}`,
  ].join('\n');

  try {
    const response = await model.generate(ctx, {
      messages: [
        {
          role: 'system',
          content: 'You are a skill selector. Return strict JSON and prefer no skill over weak skill fit.',
        },
        {
          role: 'user',
          content: selectionPrompt,
        },
      ],
      temperature: 0,
      maxTokens: 350,
    });

    const parsed = parseJson(response.content);
    if (!parsed || typeof parsed !== 'object') return null;

    const rec = parsed as Record<string, unknown>;
    const selectedRaw = Array.isArray(rec['selectedSkillIds']) ? rec['selectedSkillIds'] : [];
    const selectedSkillIds = selectedRaw
      .filter((item): item is string => typeof item === 'string')
      .filter((id) => candidates.some((candidate) => candidate.skill.id === id))
      .slice(0, 3);

    const normalizedSelected = applyTagBasedRouting(query, candidates, selectedSkillIds, hasTabularAttachment);

    const useNoSkillPath = rec['useNoSkillPath'] === true;
    const rationale = typeof rec['rationale'] === 'string' ? rec['rationale'] : undefined;

    return { selectedSkillIds: normalizedSelected, useNoSkillPath, rationale };
  } catch {
    return null;
  }
}

// ── Exported helpers ────────────────────────────────────────

export async function discoverSkillsForInput(
  db: DatabaseAdapter,
  userContent: string,
  model: Model,
  ctx: ExecutionContext,
  mode: 'direct' | 'agent' | 'supervisor' | 'ensemble',
  parseJson: (text: string) => unknown,
  runtimeHints?: { hasTabularAttachment?: boolean },
  // Optional scope enforcement: when provided, skills are filtered by the current scope context.
  // When absent, all selected skills are returned (backwards-compatible behaviour).
  scopeGuard?: ChatScopeGuard,
  scopeCtx?: ScopeContext,
): Promise<{ matches: SkillMatch[]; toolNames: string[] }> {
  try {
    const rows = await db.listEnabledSkills();
    if (!rows.length) return { matches: [], toolNames: [] };

    const registry = createSkillRegistry();
    for (const row of rows) {
      registry.register(skillFromRow(row));
    }

    const allSkills = registry.list();
    const hasTabularAttachment = runtimeHints?.hasTabularAttachment === true;

    const activation = await activateSkills(userContent, allSkills, {
      maxCandidates: 6,
      maxSelected: 3,
      minScore: 0.08,
      mode: mode === 'direct' ? 'advisory' : 'tool_assisted',
      context: { chatMode: mode },
      selector: async ({ query, mode: invokeMode, candidates }) => {
        const decision = await reasonAboutSkillSelection(model, ctx, query, invokeMode, candidates, parseJson, hasTabularAttachment);
        if (!decision) {
          return {
            selectedSkillIds: applyTagBasedRouting(
              query,
              candidates,
              candidates.slice(0, 3).map((candidate) => candidate.skill.id),
              hasTabularAttachment,
            ),
            rationale: 'Fallback to semantic ranking because reasoning selector did not return a valid decision.',
          };
        }
        return decision;
      },
      policyEvaluator: ({ skill, mode: invokeMode }) => {
        const disallowed = skill.policy?.sideEffectsAllowed === false && invokeMode === 'side_effect_eligible';
        if (disallowed) {
          return { allowed: false, reason: 'Skill blocks side-effect eligible execution in current mode.' };
        }
        return {
          allowed: true,
          enforcedAllowedTools: skill.policy?.allowedTools,
        };
      },
    });

    let matches = [...activation.selected];

    if (hasTabularAttachment && mode !== 'direct') {
      // Inject any enabled skill tagged 'auto-on-tabular' (skill metadata
      // declares its own auto-activation, no IDs are hardcoded here).
      const autoTabularSkills = allSkills.filter(
        (skill) => skill.enabled !== false && Array.isArray(skill.tags) && skill.tags.includes('auto-on-tabular'),
      );
      for (const autoSkill of autoTabularSkills) {
        if (matches.some((match) => match.skill.id === autoSkill.id)) continue;
        const syntheticScore = Math.max(0.25, matches[0]?.score ?? 0.25);
        matches = [
          {
            skill: autoSkill,
            score: syntheticScore,
            matchedPatterns: [],
            rationale: `Tabular attachment detected; skill "${autoSkill.name}" is tagged auto-on-tabular.`,
            source: 'reasoning' as const,
          },
          ...matches,
        ]
          .filter((item, index, arr) => arr.findIndex((x) => x.skill.id === item.skill.id) === index)
          .slice(0, 3);
      }

      // Drop any selected skill tagged 'requires-intent-match' when the query
      // does not semantically match the skill's own corpus.
      matches = matches.filter((match) => {
        if (!Array.isArray(match.skill.tags) || !match.skill.tags.includes('requires-intent-match')) return true;
        const corpus = [
          match.skill.description,
          match.skill.summary,
          Array.isArray(match.skill.triggerPatterns) ? match.skill.triggerPatterns.join(' ') : '',
          Array.isArray(match.skill.tags) ? match.skill.tags.join(' ') : '',
        ].filter(Boolean).join(' ');
        return semanticIntentScore(userContent, corpus) >= INTENT_MATCH_THRESHOLD;
      });
    }

    // ── Scope enforcement ────────────────────────────────────────────────
    // When a scope guard and context are provided, filter out skills that the
    // current scope cannot access. This is the primary enforcement point for
    // the analytics→kaggle boundary (and others).
    if (scopeGuard && scopeCtx) {
      const { allowed, rejected } = await scopeGuard.filterSkillsByScope(matches, scopeCtx);
      if (rejected.length > 0) {
        const rejectedNames = rejected.map((r) => r.match.skill.id).join(', ');
        console.info(`[scope] Filtered ${rejected.length} out-of-scope skill(s): ${rejectedNames}`);
      }
      matches = allowed;
    }

    const toolNames = collectSkillTools(matches);
    return { matches, toolNames };
  } catch {
    return { matches: [], toolNames: [] };
  }
}
