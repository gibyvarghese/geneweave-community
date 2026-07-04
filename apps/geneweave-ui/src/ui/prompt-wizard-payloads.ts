import { slugifyPromptKey } from './prompt-wizard-utils.js';

function parseCsvList(value: unknown): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildQueuedPromptWizardFragment(fragments: any): any | null {
  const key = slugifyPromptKey(fragments.key || fragments.name);
  const name = String(fragments.name || '').trim();
  const content = String(fragments.content || '').trim();
  if (!key || !name || !content) return null;

  return {
    key,
    name,
    description: String(fragments.description || '').trim(),
    category: String(fragments.category || 'context').trim() || 'context',
    content,
    tags: parseCsvList(fragments.tagsCsv),
  };
}

export function buildPromptFragmentCreatePayload(fragment: any): any {
  return {
    key: fragment.key,
    name: fragment.name,
    description: fragment.description || 'Prompt fragment created by prompt setup wizard.',
    category: fragment.category || 'context',
    content: fragment.content,
    variables: [],
    tags: fragment.tags || [],
    version: '1.0',
    enabled: true,
  };
}

export function buildPromptFrameworkCreatePayload(wizard: any, key: string): any {
  return {
    key,
    name: String(wizard.framework.name || key).trim(),
    description: String(wizard.framework.description || 'Framework created by prompt setup wizard.').trim(),
    sections: wizard.framework.sections,
    section_separator: String(wizard.framework.sectionSeparator || '\n\n'),
    enabled: true,
  };
}

export function buildPromptStrategyCreatePayload(wizard: any, key: string): any {
  return {
    key,
    name: String(wizard.strategy.name || key).trim(),
    description: String(wizard.strategy.description || 'Prompt execution strategy created by prompt setup wizard.').trim(),
    instruction_prefix: String(wizard.strategy.instructionPrefix || '').trim() || null,
    instruction_suffix: String(wizard.strategy.instructionSuffix || '').trim() || null,
    config: wizard.strategy.wrapTag
      ? JSON.stringify({ wrapTag: String(wizard.strategy.wrapTag).trim() })
      : JSON.stringify({}),
    enabled: true,
  };
}

export function buildPromptContractCreatePayload(wizard: any, key: string): any {
  return {
    key,
    name: String(wizard.contract.name || key).trim(),
    description: String(wizard.contract.description || 'Output contract created by prompt setup wizard.').trim(),
    contract_type: String(wizard.contract.contractType || 'json'),
    schema: String(wizard.contract.schema || '').trim() || '{}',
    config: String(wizard.contract.config || '').trim() || '{}',
    enabled: true,
  };
}

export function buildPromptExecutionDefaults(
  selectedStrategyKey: string,
  selectedContractKey: string,
): Record<string, unknown> {
  const executionDefaults: Record<string, unknown> = {};
  if (selectedStrategyKey) executionDefaults['strategy'] = selectedStrategyKey;
  if (selectedContractKey) executionDefaults['outputContractId'] = selectedContractKey;
  return executionDefaults;
}

export function buildPromptWizardPayload(
  wizard: any,
  promptKey: string,
  promptName: string,
  promptDescription: string,
  promptTemplate: string,
  selectedFrameworkKey: string,
  selectedStrategyKey: string,
  selectedContractKey: string,
  queuedFragments: any[],
): any {
  return {
    key: promptKey,
    name: promptName,
    description: promptDescription,
    category: String(wizard.prompt.category || 'analysis'),
    prompt_type: String(wizard.prompt.prompt_type || 'template'),
    owner: 'admin',
    status: String(wizard.prompt.status || 'published'),
    tags: parseCsvList(wizard.prompt.tagsCsv),
    template: promptTemplate,
    variables: parseCsvList(wizard.prompt.variablesCsv),
    model_compatibility: {},
    execution_defaults: buildPromptExecutionDefaults(selectedStrategyKey, selectedContractKey),
    framework: selectedFrameworkKey ? JSON.stringify(selectedFrameworkKey) : null,
    metadata: {
      createdFrom: 'prompt-setup-wizard',
      fragmentKeys: queuedFragments.map((fragment: any) => fragment.key),
    },
    version: String(wizard.prompt.version || '1.0'),
    is_default: false,
    enabled: true,
  };
}