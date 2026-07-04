/**
 * Framework seed — writes default package seed arrays to the database.
 *
 * Each section is idempotent: it checks existence before inserting, and
 * backfills any new entries added to DEFAULT_* arrays in package updates.
 * Call this from applySeed() only; do not call directly from app startup.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { getModelCapabilityFlags } from '@weaveintel/routing';
import { DEFAULT_GUARDRAILS } from '@weaveintel/guardrails';
import {
  DEFAULT_ROUTING_POLICIES,
  DEFAULT_MODEL_PRICING,
  DEFAULT_TASK_TYPES,
  DEFAULT_PROVIDER_ADAPTERS,
} from '@weaveintel/routing';
import { DEFAULT_HANDLER_KINDS, DEFAULT_ATTENTION_POLICIES } from '@weaveintel/live-agents';
import { DEFAULT_COST_POLICIES } from '@weaveintel/cost-governor';
import { BUILT_IN_SKILLS, mapSkillToRow } from '@weaveintel/skills';
import type { DatabaseAdapter } from '../db-types.js';

export async function seedFramework(db: DatabaseAdapter): Promise<void> {
  // ── Guardrails ───────────────────────────────────────────────────────────────
  const existingGuardrails = await db.listGuardrails();
  if (existingGuardrails.length === 0) {
    for (const g of DEFAULT_GUARDRAILS) await db.createGuardrail(g);
  } else {
    const existingIds = new Set(existingGuardrails.map(g => g.id));
    for (const g of DEFAULT_GUARDRAILS) {
      if (!existingIds.has(g.id)) await db.createGuardrail(g);
    }
  }

  // ── Routing Policies ─────────────────────────────────────────────────────────
  const existingPolicies = await db.listRoutingPolicies();
  if (existingPolicies.length === 0) {
    for (const p of DEFAULT_ROUTING_POLICIES) await db.createRoutingPolicy(p);
  } else {
    // Backfill any new policies added to DEFAULT_ROUTING_POLICIES
    const existingPolicyIds = new Set(existingPolicies.map(p => p.id));
    for (const p of DEFAULT_ROUTING_POLICIES) {
      if (!existingPolicyIds.has(p.id)) await db.createRoutingPolicy(p);
    }
  }

  // ── Model Pricing ─────────────────────────────────────────────────────────────
  const existingPricing = await db.listModelPricing();
  if (existingPricing.length === 0) {
    for (const p of DEFAULT_MODEL_PRICING) await db.createModelPricing(p);
  } else {
    // Backfill new model rows by (model_id, provider) composite key
    const existingPricingKeys = new Set(
      existingPricing.map(p => `${p.model_id}:${p.provider}`),
    );
    for (const p of DEFAULT_MODEL_PRICING) {
      if (!existingPricingKeys.has(`${p.model_id}:${p.provider}`)) {
        await db.createModelPricing(p);
      }
    }
  }

  // ── Task Type Definitions ─────────────────────────────────────────────────────
  const existingTaskTypes = await db.listTaskTypes();
  if (existingTaskTypes.length === 0) {
    for (const t of DEFAULT_TASK_TYPES) {
      await db.createTaskType({
        id:               newUUIDv7(),
        task_key:         t.task_key,
        display_name:     t.display_name,
        category:         t.category,
        description:      t.description,
        output_modality:  t.output_modality,
        default_strategy: t.default_strategy,
        default_weights:  JSON.stringify(t.default_weights),
        inference_hints:  JSON.stringify(t.inference_hints),
        enabled:          1,
      });
    }
  } else {
    // Backfill any new task types added since last seed
    const existingTaskKeys = new Set(existingTaskTypes.map(t => t.task_key));
    for (const t of DEFAULT_TASK_TYPES) {
      if (!existingTaskKeys.has(t.task_key)) {
        await db.createTaskType({
          id:               newUUIDv7(),
          task_key:         t.task_key,
          display_name:     t.display_name,
          category:         t.category,
          description:      t.description,
          output_modality:  t.output_modality,
          default_strategy: t.default_strategy,
          default_weights:  JSON.stringify(t.default_weights),
          inference_hints:  JSON.stringify(t.inference_hints),
          enabled:          1,
        });
      }
    }
  }

  // ── Provider Tool Adapters ────────────────────────────────────────────────────
  const existingAdapters = await db.listProviderToolAdapters();
  if (existingAdapters.length === 0) {
    for (const a of DEFAULT_PROVIDER_ADAPTERS) {
      await db.createProviderToolAdapter({ id: newUUIDv7(), ...a });
    }
  } else {
    // Backfill any new providers (including mid-2026 additions)
    const existingProviders = new Set(existingAdapters.map(a => a.provider));
    for (const a of DEFAULT_PROVIDER_ADAPTERS) {
      if (!existingProviders.has(a.provider)) {
        await db.createProviderToolAdapter({ id: newUUIDv7(), ...a });
      }
    }
  }

  // ── Cost Policies (framework tiers) ──────────────────────────────────────────
  const existingCostPolicies = await db.listCostPolicies();
  const existingCostKeys = new Set(existingCostPolicies.map(p => p.key));
  for (const p of DEFAULT_COST_POLICIES) {
    if (!existingCostKeys.has(p.key)) {
      await db.createCostPolicy({
        id:          p.id,
        key:         p.key,
        tier:        p.tier,
        levers_json: p.levers_json,
        description: p.description,
        enabled:     p.enabled,
      });
    }
  }

  // ── Live Agent Handler Kinds ──────────────────────────────────────────────────
  for (const k of DEFAULT_HANDLER_KINDS) {
    const existing = await db.getLiveHandlerKindByKind(k.kind);
    if (!existing) await db.createLiveHandlerKind(k);
  }

  // ── Live Agent Attention Policies ─────────────────────────────────────────────
  for (const p of DEFAULT_ATTENTION_POLICIES) {
    const existing = await db.getLiveAttentionPolicyByKey(p.key);
    if (!existing) await db.createLiveAttentionPolicy(p);
  }

  // ── Skills (BUILT_IN_SKILLS from @weaveintel/skills) ──────────────────────────
  const existingSkills = await db.listSkills();
  if (existingSkills.length === 0) {
    for (const s of BUILT_IN_SKILLS) await db.createSkill(mapSkillToRow(s));
  } else {
    const existingSkillIds = new Set(existingSkills.map(s => s.id));
    for (const s of BUILT_IN_SKILLS) {
      if (!existingSkillIds.has(s.id)) await db.createSkill(mapSkillToRow(s));
    }
  }

  // ── Model Capability Scores ────────────────────────────────────────────────────
  const existingScores = await db.listCapabilityScores();
  if (existingScores.length === 0) {
    await seedModelCapabilityScores(db);
  } else {
    await backfillNewModelCapabilityScores(db, existingScores);
  }
}

// ── All model × task capability definitions ──────────────────────────────────

type CapSeed = { model_id: string; provider: string; task_key: string; quality_score: number };

function buildAllCapabilityScores(): CapSeed[] {
  const scores: CapSeed[] = [
    // ── Anthropic ──────────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'long_document', 'mathematical_reasoning', 'scientific_analysis', 'structured_extraction', 'multi_turn_agent'].map(task => ({
      model_id: 'claude-opus-4-7', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 95, summarization: 90, translation: 88, classification: 90, extraction: 92, qa: 93, code_generation: 94, code_debug: 95, code_review: 95, creative_writing: 96, conversation: 92, tool_use: 93, vision_understanding: 90, long_document: 92, mathematical_reasoning: 94, scientific_analysis: 93, structured_extraction: 91, multi_turn_agent: 92 } as Record<string,number>)[task] ?? 90,
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'structured_extraction', 'multi_turn_agent'].map(task => ({
      model_id: 'claude-sonnet-4-6', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 88, summarization: 88, translation: 86, classification: 88, extraction: 89, qa: 88, code_generation: 90, code_debug: 89, code_review: 88, creative_writing: 90, conversation: 90, tool_use: 89, vision_understanding: 86, structured_extraction: 88, multi_turn_agent: 87 } as Record<string,number>)[task] ?? 85,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use'].map(task => ({
      model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', task_key: task,
      quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 75, translation: 74, conversation: 80, tool_use: 75 } as Record<string,number>)[task] ?? 70,
    })),
    // claude-fable-5: frontier flagship mid-2026
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'long_document', 'mathematical_reasoning', 'scientific_analysis', 'structured_extraction', 'multi_turn_agent'].map(task => ({
      model_id: 'claude-fable-5', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 97, summarization: 95, translation: 94, classification: 95, extraction: 96, qa: 97, code_generation: 97, code_debug: 97, code_review: 97, creative_writing: 98, conversation: 96, tool_use: 96, vision_understanding: 95, long_document: 96, mathematical_reasoning: 97, scientific_analysis: 97, structured_extraction: 96, multi_turn_agent: 96 } as Record<string,number>)[task] ?? 95,
    })),
    // claude-opus-4-8: computer-use flagship
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'long_document', 'mathematical_reasoning', 'scientific_analysis', 'structured_extraction', 'multi_turn_agent', 'computer_use'].map(task => ({
      model_id: 'claude-opus-4-8', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 95, summarization: 93, translation: 91, classification: 93, extraction: 94, qa: 95, code_generation: 95, code_debug: 95, code_review: 95, creative_writing: 95, conversation: 94, tool_use: 95, vision_understanding: 93, long_document: 94, mathematical_reasoning: 95, scientific_analysis: 94, structured_extraction: 94, multi_turn_agent: 94, computer_use: 96 } as Record<string,number>)[task] ?? 93,
    })),

    // ── OpenAI ─────────────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'structured_extraction', 'multi_turn_agent'].map(task => ({
      model_id: 'gpt-4o', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 88, summarization: 90, translation: 92, classification: 89, extraction: 90, qa: 91, code_generation: 89, code_debug: 88, code_review: 87, creative_writing: 88, conversation: 91, tool_use: 92, vision_understanding: 92, structured_extraction: 90, multi_turn_agent: 89 } as Record<string,number>)[task] ?? 88,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4o-mini', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 82, tool_use: 80, vision_understanding: 78 } as Record<string,number>)[task] ?? 75,
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'long_document', 'structured_extraction', 'multi_turn_agent'].map(task => ({
      model_id: 'gpt-4.1', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 89, summarization: 89, translation: 90, classification: 89, extraction: 90, qa: 90, code_generation: 91, code_debug: 90, code_review: 88, creative_writing: 87, conversation: 89, tool_use: 91, vision_understanding: 89, long_document: 90, structured_extraction: 90, multi_turn_agent: 89 } as Record<string,number>)[task] ?? 88,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4.1-mini', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 81, tool_use: 80, vision_understanding: 76 } as Record<string,number>)[task] ?? 75,
    })),
    ...['summarization', 'classification', 'extraction', 'conversation'].map(task => ({
      model_id: 'gpt-4.1-nano', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 70, classification: 72, extraction: 68, conversation: 72 } as Record<string,number>)[task] ?? 65,
    })),
    ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use', 'mathematical_reasoning', 'scientific_analysis', 'structured_extraction'].map(task => ({
      model_id: 'o3', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 96, qa: 90, code_generation: 92, code_debug: 94, code_review: 91, tool_use: 88, mathematical_reasoning: 97, scientific_analysis: 93, structured_extraction: 89 } as Record<string,number>)[task] ?? 88,
    })),
    ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use', 'mathematical_reasoning'].map(task => ({
      model_id: 'o4-mini', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 88, qa: 82, code_generation: 86, code_debug: 87, code_review: 84, tool_use: 82, mathematical_reasoning: 89 } as Record<string,number>)[task] ?? 80,
    })),

    // ── Google ─────────────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding', 'audio_understanding', 'video_understanding', 'long_document', 'structured_extraction', 'multi_turn_agent', 'scientific_analysis'].map(task => ({
      model_id: 'gemini-2.5-pro', provider: 'google', task_key: task,
      quality_score: ({ reasoning: 90, summarization: 87, translation: 90, classification: 88, extraction: 89, qa: 90, code_generation: 88, code_debug: 87, code_review: 87, creative_writing: 87, conversation: 88, tool_use: 90, vision_understanding: 92, audio_understanding: 88, video_understanding: 90, long_document: 92, structured_extraction: 88, multi_turn_agent: 88, scientific_analysis: 89 } as Record<string,number>)[task] ?? 88,
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'conversation', 'tool_use', 'vision_understanding', 'audio_understanding', 'long_document'].map(task => ({
      model_id: 'gemini-2.5-flash', provider: 'google', task_key: task,
      quality_score: ({ reasoning: 80, summarization: 82, translation: 84, classification: 82, extraction: 81, qa: 82, code_generation: 78, conversation: 80, tool_use: 80, vision_understanding: 82, audio_understanding: 80, long_document: 82 } as Record<string,number>)[task] ?? 78,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation'].map(task => ({
      model_id: 'gemini-2.5-flash-lite', provider: 'google', task_key: task,
      quality_score: ({ summarization: 74, classification: 75, extraction: 72, qa: 72, conversation: 70 } as Record<string,number>)[task] ?? 68,
    })),

    // ── xAI Grok ──────────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'mathematical_reasoning', 'scientific_analysis'].map(task => ({
      model_id: 'grok-3', provider: 'xai', task_key: task,
      quality_score: ({ reasoning: 89, summarization: 86, translation: 85, classification: 87, extraction: 87, qa: 89, code_generation: 88, code_debug: 87, code_review: 86, creative_writing: 87, conversation: 88, tool_use: 88, mathematical_reasoning: 90, scientific_analysis: 88 } as Record<string,number>)[task] ?? 86,
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'mathematical_reasoning', 'scientific_analysis', 'long_document'].map(task => ({
      model_id: 'grok-4', provider: 'xai', task_key: task,
      quality_score: ({ reasoning: 92, summarization: 90, translation: 89, classification: 91, extraction: 91, qa: 92, code_generation: 91, code_debug: 91, code_review: 90, creative_writing: 90, conversation: 91, tool_use: 91, mathematical_reasoning: 93, scientific_analysis: 91, long_document: 91 } as Record<string,number>)[task] ?? 89,
    })),

    // ── DeepSeek API ──────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'conversation', 'tool_use', 'structured_extraction'].map(task => ({
      model_id: 'deepseek-v3', provider: 'deepseek', task_key: task,
      quality_score: ({ reasoning: 87, summarization: 85, classification: 86, extraction: 87, qa: 87, code_generation: 89, code_debug: 88, code_review: 87, conversation: 85, tool_use: 86, structured_extraction: 86 } as Record<string,number>)[task] ?? 84,
    })),
    ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'mathematical_reasoning', 'scientific_analysis'].map(task => ({
      model_id: 'deepseek-r1-api', provider: 'deepseek', task_key: task,
      quality_score: ({ reasoning: 93, qa: 87, code_generation: 88, code_debug: 90, code_review: 88, mathematical_reasoning: 94, scientific_analysis: 91 } as Record<string,number>)[task] ?? 86,
    })),

    // ── Mistral API ────────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'structured_extraction'].map(task => ({
      model_id: 'mistral-large-2', provider: 'mistral', task_key: task,
      quality_score: ({ reasoning: 86, summarization: 85, translation: 88, classification: 86, extraction: 87, qa: 86, code_generation: 85, code_debug: 85, code_review: 84, creative_writing: 84, conversation: 85, tool_use: 85, structured_extraction: 86 } as Record<string,number>)[task] ?? 83,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use'].map(task => ({
      model_id: 'mistral-medium-3', provider: 'mistral', task_key: task,
      quality_score: ({ summarization: 79, classification: 80, extraction: 78, qa: 78, translation: 80, conversation: 79, tool_use: 78 } as Record<string,number>)[task] ?? 76,
    })),
    ...['code_generation', 'code_debug', 'code_review'].map(task => ({
      model_id: 'codestral', provider: 'mistral', task_key: task,
      quality_score: ({ code_generation: 86, code_debug: 85, code_review: 84 } as Record<string,number>)[task] ?? 83,
    })),

    // ── Amazon Bedrock ─────────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'conversation', 'tool_use', 'vision_understanding', 'structured_extraction'].map(task => ({
      model_id: 'amazon-nova-pro', provider: 'amazon', task_key: task,
      quality_score: ({ reasoning: 82, summarization: 82, translation: 82, classification: 81, extraction: 82, qa: 82, code_generation: 80, conversation: 82, tool_use: 82, vision_understanding: 82, structured_extraction: 81 } as Record<string,number>)[task] ?? 80,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'vision_understanding'].map(task => ({
      model_id: 'amazon-nova-lite', provider: 'amazon', task_key: task,
      quality_score: ({ summarization: 72, classification: 72, extraction: 70, qa: 70, conversation: 72, vision_understanding: 72 } as Record<string,number>)[task] ?? 68,
    })),
    ...['summarization', 'classification', 'conversation'].map(task => ({
      model_id: 'amazon-nova-micro', provider: 'amazon', task_key: task,
      quality_score: ({ summarization: 62, classification: 62, conversation: 62 } as Record<string,number>)[task] ?? 60,
    })),

    // ── Meta Llama 4 API ───────────────────────────────────────────────────────
    ...['reasoning', 'summarization', 'classification', 'extraction', 'qa', 'code_generation', 'conversation', 'tool_use', 'long_document', 'structured_extraction'].map(task => ({
      model_id: 'llama-4-scout', provider: 'meta', task_key: task,
      quality_score: ({ reasoning: 82, summarization: 80, classification: 80, extraction: 80, qa: 81, code_generation: 79, conversation: 80, tool_use: 78, long_document: 82, structured_extraction: 79 } as Record<string,number>)[task] ?? 78,
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'conversation', 'tool_use', 'long_document', 'structured_extraction'].map(task => ({
      model_id: 'llama-4-maverick', provider: 'meta', task_key: task,
      quality_score: ({ reasoning: 86, summarization: 85, translation: 84, classification: 86, extraction: 86, qa: 86, code_generation: 87, code_debug: 86, code_review: 85, conversation: 85, tool_use: 85, long_document: 86, structured_extraction: 85 } as Record<string,number>)[task] ?? 84,
    })),

    // ── Ollama (local heuristic baselines) ────────────────────────────────────
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'tool_use'].map(task => ({
      model_id: 'llama3.1', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 72, classification: 72, extraction: 70, qa: 70, conversation: 70, tool_use: 68 } as Record<string,number>)[task] ?? 68,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation'].map(task => ({
      model_id: 'deepseek-r1', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 78, classification: 80, extraction: 78, qa: 80, conversation: 75 } as Record<string,number>)[task] ?? 72,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'tool_use', 'code_generation'].map(task => ({
      model_id: 'llama3.3', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 76, classification: 76, extraction: 74, qa: 74, conversation: 76, tool_use: 72, code_generation: 74 } as Record<string,number>)[task] ?? 72,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'code_generation', 'tool_use'].map(task => ({
      model_id: 'qwen3', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 76, conversation: 77, code_generation: 76, tool_use: 74 } as Record<string,number>)[task] ?? 74,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'code_generation'].map(task => ({
      model_id: 'phi4', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 74, classification: 74, extraction: 72, qa: 72, conversation: 73, code_generation: 74 } as Record<string,number>)[task] ?? 70,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'vision_understanding'].map(task => ({
      model_id: 'gemma3', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 76, conversation: 77, vision_understanding: 78 } as Record<string,number>)[task] ?? 74,
    })),
    ...['summarization', 'classification', 'conversation'].map(task => ({
      model_id: 'mistral-nemo', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 74, classification: 74, conversation: 73 } as Record<string,number>)[task] ?? 70,
    })),
    ...['code_generation', 'code_debug', 'code_review'].map(task => ({
      model_id: 'codestral-local', provider: 'ollama', task_key: task,
      quality_score: ({ code_generation: 82, code_debug: 82, code_review: 80 } as Record<string,number>)[task] ?? 79,
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'code_generation'].map(task => ({
      model_id: 'qwen2.5', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 74, classification: 74, extraction: 72, qa: 72, conversation: 73, code_generation: 72 } as Record<string,number>)[task] ?? 70,
    })),
  ];

  return scores;
}

async function seedModelCapabilityScores(db: DatabaseAdapter): Promise<void> {
  const scores = buildAllCapabilityScores();
  for (const s of scores) {
    const f = getModelCapabilityFlags(s.model_id);
    await db.upsertCapabilityScore({
      id:                      newUUIDv7(),
      tenant_id:               null,
      model_id:                s.model_id,
      provider:                s.provider,
      task_key:                s.task_key,
      quality_score:           s.quality_score,
      supports_tools:          1,
      supports_streaming:      1,
      supports_thinking:       f.supports_thinking,
      supports_json_mode:      f.supports_json_mode,
      supports_vision:         f.supports_vision,
      max_output_tokens:       null,
      benchmark_source:        'composite-2026q2',
      raw_benchmark_score:     null,
      is_active:               1,
      last_evaluated_at:       new Date().toISOString(),
      production_signal_score: null,
      signal_sample_count:     0,
    });
  }
}

async function backfillNewModelCapabilityScores(
  db: DatabaseAdapter,
  existingScores: { model_id: string; provider: string; task_key: string }[],
): Promise<void> {
  const existingKeys = new Set(
    existingScores.map(s => `${s.model_id}:${s.provider}:${s.task_key}`),
  );
  const allScores = buildAllCapabilityScores();
  for (const s of allScores) {
    const key = `${s.model_id}:${s.provider}:${s.task_key}`;
    if (existingKeys.has(key)) continue;
    const f = getModelCapabilityFlags(s.model_id);
    await db.upsertCapabilityScore({
      id:                      newUUIDv7(),
      tenant_id:               null,
      model_id:                s.model_id,
      provider:                s.provider,
      task_key:                s.task_key,
      quality_score:           s.quality_score,
      supports_tools:          1,
      supports_streaming:      1,
      supports_thinking:       f.supports_thinking,
      supports_json_mode:      f.supports_json_mode,
      supports_vision:         f.supports_vision,
      max_output_tokens:       null,
      benchmark_source:        'composite-2026q2',
      raw_benchmark_score:     null,
      is_active:               1,
      last_evaluated_at:       new Date().toISOString(),
      production_signal_score: null,
      signal_sample_count:     0,
    });
  }
}
