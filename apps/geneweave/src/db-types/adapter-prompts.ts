import type { ModelPricingRow } from './routing.js';
import type { PromptRow, PromptFrameworkRow, PromptFragmentRow, PromptContractRow, PromptStrategyRow, PromptVersionRow, PromptExperimentRow, PromptEvalDatasetRow, PromptEvalRunRow, PromptOptimizerRow, PromptOptimizationRunRow } from './prompts.js';

export interface IPromptStore {
  // Model Pricing
  createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getModelPricing(id: string): Promise<ModelPricingRow | null>;
  listModelPricing(): Promise<ModelPricingRow[]>;
  updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteModelPricing(id: string): Promise<void>;
  upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;

  // Prompts
  createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPrompt(id: string): Promise<PromptRow | null>;
  getPromptByKey(key: string): Promise<PromptRow | null>;
  getPromptByName(name: string): Promise<PromptRow | null>;
  listPrompts(): Promise<PromptRow[]>;
  updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePrompt(id: string): Promise<void>;

  // Prompt Versions
  createPromptVersion(v: Omit<PromptVersionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptVersion(id: string): Promise<PromptVersionRow | null>;
  listPromptVersions(promptId?: string): Promise<PromptVersionRow[]>;
  updatePromptVersion(id: string, fields: Partial<Omit<PromptVersionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptVersion(id: string): Promise<void>;

  // Prompt Experiments
  createPromptExperiment(e: Omit<PromptExperimentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptExperiment(id: string): Promise<PromptExperimentRow | null>;
  listPromptExperiments(promptId?: string): Promise<PromptExperimentRow[]>;
  updatePromptExperiment(id: string, fields: Partial<Omit<PromptExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptExperiment(id: string): Promise<void>;

  // Prompt Eval Datasets
  createPromptEvalDataset(d: Omit<PromptEvalDatasetRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptEvalDataset(id: string): Promise<PromptEvalDatasetRow | null>;
  listPromptEvalDatasets(promptId?: string): Promise<PromptEvalDatasetRow[]>;
  updatePromptEvalDataset(id: string, fields: Partial<Omit<PromptEvalDatasetRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptEvalDataset(id: string): Promise<void>;

  // Prompt Eval Runs
  createPromptEvalRun(r: Omit<PromptEvalRunRow, 'created_at'>): Promise<void>;
  getPromptEvalRun(id: string): Promise<PromptEvalRunRow | null>;
  listPromptEvalRuns(datasetId?: string): Promise<PromptEvalRunRow[]>;
  deletePromptEvalRun(id: string): Promise<void>;

  // Prompt Optimizers
  createPromptOptimizer(o: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptOptimizer(id: string): Promise<PromptOptimizerRow | null>;
  getPromptOptimizerByKey(key: string): Promise<PromptOptimizerRow | null>;
  listPromptOptimizers(): Promise<PromptOptimizerRow[]>;
  updatePromptOptimizer(id: string, fields: Partial<Omit<PromptOptimizerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptOptimizer(id: string): Promise<void>;

  // Prompt Optimization Runs
  createPromptOptimizationRun(r: Omit<PromptOptimizationRunRow, 'created_at'>): Promise<void>;
  getPromptOptimizationRun(id: string): Promise<PromptOptimizationRunRow | null>;
  listPromptOptimizationRuns(promptId?: string): Promise<PromptOptimizationRunRow[]>;
  deletePromptOptimizationRun(id: string): Promise<void>;

  // Prompt Frameworks
  createPromptFramework(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFramework(id: string): Promise<PromptFrameworkRow | null>;
  getPromptFrameworkByKey(key: string): Promise<PromptFrameworkRow | null>;
  listPromptFrameworks(): Promise<PromptFrameworkRow[]>;
  updatePromptFramework(id: string, fields: Partial<Omit<PromptFrameworkRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFramework(id: string): Promise<void>;

  // Prompt Fragments
  createPromptFragment(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFragment(id: string): Promise<PromptFragmentRow | null>;
  getPromptFragmentByKey(key: string): Promise<PromptFragmentRow | null>;
  listPromptFragments(): Promise<PromptFragmentRow[]>;
  updatePromptFragment(id: string, fields: Partial<Omit<PromptFragmentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFragment(id: string): Promise<void>;

  // Prompt Contracts
  createPromptContract(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptContract(id: string): Promise<PromptContractRow | null>;
  getPromptContractByKey(key: string): Promise<PromptContractRow | null>;
  listPromptContracts(): Promise<PromptContractRow[]>;
  updatePromptContract(id: string, fields: Partial<Omit<PromptContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptContract(id: string): Promise<void>;

  // Prompt Strategies
  createPromptStrategy(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptStrategy(id: string): Promise<PromptStrategyRow | null>;
  getPromptStrategyByKey(key: string): Promise<PromptStrategyRow | null>;
  listPromptStrategies(): Promise<PromptStrategyRow[]>;
  updatePromptStrategy(id: string, fields: Partial<Omit<PromptStrategyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptStrategy(id: string): Promise<void>;
}
