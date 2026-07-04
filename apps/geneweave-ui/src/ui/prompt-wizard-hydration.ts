import {
  defaultWizardFrameworkSections,
  parseWizardObject,
  stripPossibleJsonQuotes,
} from './prompt-wizard-utils.js';

function parseJsonMaybeLoose(value: unknown): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function hydrateWizardFromPromptRow(wizard: any, promptRow: any, frameworkRows: any[]): void {
  const promptId = String(promptRow?.id || '');
  const promptName = String(promptRow?.name || '');
  const promptKey = String(promptRow?.key || promptName);
  const vars = Array.isArray(promptRow?.variables)
    ? promptRow.variables
    : parseJsonMaybeLoose(promptRow?.variables);
  const tags = Array.isArray(promptRow?.tags)
    ? promptRow.tags
    : parseJsonMaybeLoose(promptRow?.tags);

  wizard.mode = 'edit';
  wizard.editingPromptId = promptId;
  wizard.selectedPromptId = promptId;
  wizard.prompt.key = promptKey;
  wizard.prompt.name = promptName;
  wizard.prompt.description = String(promptRow?.description || '');
  wizard.prompt.category = String(promptRow?.category || 'analysis');
  wizard.prompt.prompt_type = String(promptRow?.prompt_type || 'template');
  wizard.prompt.status = String(promptRow?.status || 'published');
  wizard.prompt.version = String(promptRow?.version || '1.0');
  wizard.prompt.variablesCsv = Array.isArray(vars) ? vars.join(', ') : '';
  wizard.prompt.tagsCsv = Array.isArray(tags) ? tags.join(', ') : '';
  wizard.prompt.template = String(promptRow?.template || '');

  const frameworkRaw = parseJsonMaybeLoose(promptRow?.framework);
  const frameworkKey = typeof frameworkRaw === 'string'
    ? stripPossibleJsonQuotes(frameworkRaw)
    : typeof frameworkRaw?.key === 'string'
      ? String(frameworkRaw.key)
      : '';
  wizard.framework.selectedKey = frameworkKey;

  const execDefaults = parseWizardObject(promptRow?.execution_defaults, {});
  wizard.strategy.selectedKey = typeof execDefaults['strategy'] === 'string' ? String(execDefaults['strategy']) : '';
  wizard.contract.selectedKey = typeof execDefaults['outputContractId'] === 'string' ? String(execDefaults['outputContractId']) : '';

  const selectedFramework = frameworkRows.find((row: any) => row.key === frameworkKey);
  const frameworkSections = Array.isArray(parseJsonMaybeLoose(selectedFramework?.sections))
    ? parseJsonMaybeLoose(selectedFramework?.sections)
    : [];
  wizard.framework.sections = frameworkSections.length
    ? frameworkSections.map((section: any) => ({
        key: String(section.key || ''),
        label: String(section.label || section.key || ''),
        required: !!section.required,
        header: section.header === null ? null : String(section.header || `## ${section.label || section.key || ''}\\n`),
      }))
    : defaultWizardFrameworkSections();

  wizard.status = `Loaded prompt package ${promptName || promptId} for editing.`;
  wizard.error = '';
}