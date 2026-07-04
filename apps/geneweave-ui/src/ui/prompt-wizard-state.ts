import { defaultWizardFrameworkSections } from './prompt-wizard-utils.js';

export function ensurePromptWizardState(state: any): any {
  const existing = state.promptWizard;
  if (existing && typeof existing === 'object') return existing;

  const next = {
    prompt: {
      key: '',
      name: '',
      description: '',
      category: 'analysis',
      prompt_type: 'template',
      status: 'published',
      version: '1.0',
      variablesCsv: '',
      tagsCsv: '',
      template: '',
      cursorStart: 0,
      cursorEnd: 0,
    },
    framework: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      sectionSeparator: '\\n\\n',
      sections: defaultWizardFrameworkSections(),
      newSectionKey: 'constraints',
    },
    strategy: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      instructionPrefix: '',
      instructionSuffix: '',
      wrapTag: '',
    },
    contract: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      contractType: 'json',
      schema: '{\\n  "type": "object"\\n}',
      config: '{\\n  "required": []\\n}',
    },
    fragments: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      category: 'context',
      content: '',
      tagsCsv: '',
      queued: [] as any[],
    },
    saving: false,
    status: '',
    error: '',
    mode: 'create',
    editingPromptId: '',
    selectedPromptId: '',
  };

  state.promptWizard = next;
  return next;
}

export function resetPromptWizard(state: any, mode: 'create' | 'edit' = 'create'): any {
  state.promptWizard = null;
  const wizard = ensurePromptWizardState(state);
  wizard.mode = mode;
  wizard.editingPromptId = '';
  wizard.selectedPromptId = '';
  wizard.status = '';
  wizard.error = '';
  return wizard;
}