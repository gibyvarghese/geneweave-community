import { api, loadAdmin } from './api.js';
import { h } from './dom.js';
import { state } from './state.js';
import { adminBackToList } from './admin-ui.js';
import {
  promptWizardRows,
  extractTemplateTokens,
} from './prompt-wizard-derivation.js';
import {
  hydrateWizardFromPromptRow,
} from './prompt-wizard-hydration.js';
import {
  buildQueuedPromptWizardFragment,
  buildPromptContractCreatePayload,
  buildPromptFragmentCreatePayload,
  buildPromptFrameworkCreatePayload,
  buildPromptStrategyCreatePayload,
  buildPromptWizardPayload,
} from './prompt-wizard-payloads.js';
import {
  ensurePromptWizardState,
  resetPromptWizard,
} from './prompt-wizard-state.js';
import {
  insertFragmentMarkerIntoTemplate,
  moveWizardFrameworkSection,
  renderPromptTemplatePreview,
} from './prompt-wizard-ui.js';
import {
  slugifyPromptKey,
  ensureWizardFrameworkSections,
  buildFrameworkSectionsFromWizard,
} from './prompt-wizard-utils.js';

export function hydrateWizardFromPrompt(promptRow: any): void {
  const wizard = resetPromptWizard(state, 'edit');
  const frameworkRows = promptWizardRows(state.adminData, 'prompt-frameworks');
  hydrateWizardFromPromptRow(wizard, promptRow, frameworkRows);
}

function queuePromptWizardFragment(render: () => void): void {
  const wizard = ensurePromptWizardState(state);
  const fragment = buildQueuedPromptWizardFragment(wizard.fragments);
  if (!fragment) {
    wizard.error = 'Fragment key, name, and content are required before adding to queue.';
    wizard.status = '';
    render();
    return;
  }

  wizard.fragments.queued = [
    ...(wizard.fragments.queued || []).filter((entry: any) => entry.key !== fragment.key),
    fragment,
  ];

  wizard.fragments.key = '';
  wizard.fragments.name = '';
  wizard.fragments.description = '';
  wizard.fragments.content = '';
  wizard.fragments.tagsCsv = '';
  wizard.status = `Queued fragment ${fragment.key}.`;
  wizard.error = '';
  render();
}

async function savePromptWizardPackage(render: () => void): Promise<void> {
  const wizard = ensurePromptWizardState(state);
  if (wizard.saving) return;

  const promptName = String(wizard.prompt.name || '').trim();
  const promptKey = slugifyPromptKey(wizard.prompt.key || promptName);
  const promptDescription = String(wizard.prompt.description || '').trim();
  const promptTemplate = String(wizard.prompt.template || '').trim();
  if (!promptKey || !promptName || !promptDescription || !promptTemplate) {
    wizard.error = 'Prompt key, name, detailed description, and template are required.';
    wizard.status = '';
    render();
    return;
  }

  wizard.saving = true;
  wizard.error = '';
  wizard.status = 'Saving prompt package...';
  render();

  try {
    const frameworkRows = promptWizardRows(state.adminData, 'prompt-frameworks');
    const strategyRows = promptWizardRows(state.adminData, 'prompt-strategies');
    const contractRows = promptWizardRows(state.adminData, 'prompt-contracts');
    const fragmentRows = promptWizardRows(state.adminData, 'prompt-fragments');

    let selectedFrameworkKey = String(wizard.framework.selectedKey || '').trim();
    if (wizard.framework.createNew) {
      const key = slugifyPromptKey(wizard.framework.key || wizard.framework.name);
      if (!key) throw new Error('Framework key or name is required to create a new framework.');
      const existing = frameworkRows.find((row: any) => row.key === key);
      if (!existing) {
        const frameworkPayload = buildPromptFrameworkCreatePayload({
          ...wizard,
          framework: {
            ...wizard.framework,
            sections: buildFrameworkSectionsFromWizard(wizard),
          },
        }, key);
        await api.post('/admin/prompt-frameworks', frameworkPayload);
      }
      selectedFrameworkKey = key;
    }

    let selectedStrategyKey = String(wizard.strategy.selectedKey || '').trim();
    if (wizard.strategy.createNew) {
      const key = slugifyPromptKey(wizard.strategy.key || wizard.strategy.name);
      if (!key) throw new Error('Strategy key or name is required to create a new strategy.');
      const existing = strategyRows.find((row: any) => row.key === key);
      if (!existing) {
        await api.post('/admin/prompt-strategies', buildPromptStrategyCreatePayload(wizard, key));
      }
      selectedStrategyKey = key;
    }

    let selectedContractKey = String(wizard.contract.selectedKey || '').trim();
    if (wizard.contract.createNew) {
      const key = slugifyPromptKey(wizard.contract.key || wizard.contract.name);
      if (!key) throw new Error('Output contract key or name is required to create a contract.');
      const existing = contractRows.find((row: any) => row.key === key);
      if (!existing) {
        await api.post('/admin/prompt-contracts', buildPromptContractCreatePayload(wizard, key));
      }
      selectedContractKey = key;
    }

    const queuedFragments = (wizard.fragments.queued || []) as any[];
    for (const fragment of queuedFragments) {
      const existing = fragmentRows.find((row: any) => row.key === fragment.key);
      if (existing) continue;
      await api.post('/admin/prompt-fragments', buildPromptFragmentCreatePayload(fragment));
    }

    const payload = buildPromptWizardPayload(
      wizard,
      promptKey,
      promptName,
      promptDescription,
      promptTemplate,
      selectedFrameworkKey,
      selectedStrategyKey,
      selectedContractKey,
      queuedFragments,
    );

    if (wizard.mode === 'edit' && wizard.editingPromptId) {
      await api.put(`/admin/prompts/${wizard.editingPromptId}`, payload);
      wizard.status = `Prompt package ${promptKey} updated successfully.`;
    } else {
      await api.post('/admin/prompts', payload);
      wizard.status = `Prompt package ${promptKey} created successfully.`;
    }

    wizard.error = '';
    wizard.fragments.queued = [];
    await loadAdmin();
    adminBackToList('prompts', render);
  } catch (e: any) {
    wizard.error = e?.message || 'Failed to create prompt package.';
    wizard.status = '';
  } finally {
    wizard.saving = false;
    render();
  }
}

export function renderPromptSetupWizard(render: () => void): HTMLElement {
  const wizard = ensurePromptWizardState(state);
  ensureWizardFrameworkSections(wizard);
  const promptsRows = promptWizardRows(state.adminData, 'prompts');
  const frameworkRows = promptWizardRows(state.adminData, 'prompt-frameworks');
  const strategyRows = promptWizardRows(state.adminData, 'prompt-strategies');
  const contractRows = promptWizardRows(state.adminData, 'prompt-contracts');
  const fragmentRows = promptWizardRows(state.adminData, 'prompt-fragments');
  const tokenSummary = extractTemplateTokens(String(wizard.prompt.template || ''));

  const box = h('div', { className: 'chart-box prompt-wizard' },
    h('div', { className: 'prompt-wizard-head' },
      h('h3', null, 'Prompt Setup Wizard'),
      h('div', { className: 'prompt-wizard-sub' }, 'Create or edit a full prompt package in one guided flow instead of editing separate tables.'),
      h('div', { className: 'prompt-wizard-inline prompt-wizard-top-actions' },
        h('select', {
          value: wizard.selectedPromptId || '',
          onChange: (e: Event) => { wizard.selectedPromptId = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'Load an existing prompt package...'),
          ...promptsRows.map((row: any) => h('option', { value: row.id }, `${row.name || row.id}`))
        ),
        h('button', {
          className: 'row-btn row-btn-edit',
          onClick: () => {
            const row = promptsRows.find((item: any) => item.id === wizard.selectedPromptId);
            if (!row) {
              wizard.error = 'Select a prompt package to load.';
              wizard.status = '';
              render();
              return;
            }
            hydrateWizardFromPrompt(row);
            render();
          },
        }, 'Load for Edit'),
        h('button', {
          className: 'row-btn',
          onClick: () => { resetPromptWizard(state, 'create'); render(); },
        }, 'Start New')
      ),
      wizard.mode === 'edit'
        ? h('div', { className: 'prompt-wizard-mode' }, `Editing prompt package: ${wizard.prompt.name || wizard.editingPromptId}`)
        : h('div', { className: 'prompt-wizard-mode' }, 'Create mode')
    )
  );

  const sectionBasics = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '1) Prompt Basics'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Prompt Name'),
        h('input', {
          type: 'text',
          value: wizard.prompt.name,
          placeholder: 'NZ Regional Economy Insights',
          onInput: (e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            wizard.prompt.name = value;
            if (!wizard.prompt.key) wizard.prompt.key = slugifyPromptKey(value);
          },
        })
      ),
      h('div', null,
        h('label', null, 'Prompt Key'),
        h('div', { className: 'prompt-wizard-inline' },
          h('input', {
            type: 'text',
            value: wizard.prompt.key,
            placeholder: 'insights.nz.regional.economy',
            onInput: (e: Event) => { wizard.prompt.key = (e.target as HTMLInputElement).value; },
          }),
          h('button', { className: 'row-btn', onClick: () => { wizard.prompt.key = slugifyPromptKey(wizard.prompt.name); render(); } }, 'Generate')
        )
      ),
      h('div', null,
        h('label', null, 'Category'),
        h('input', {
          type: 'text',
          value: wizard.prompt.category,
          placeholder: 'analysis',
          onInput: (e: Event) => { wizard.prompt.category = (e.target as HTMLInputElement).value; },
        })
      ),
      h('div', null,
        h('label', null, 'Version'),
        h('input', {
          type: 'text',
          value: wizard.prompt.version,
          placeholder: '1.0',
          onInput: (e: Event) => { wizard.prompt.version = (e.target as HTMLInputElement).value; },
        })
      )
    ),
    h('div', null,
      h('label', null, 'Detailed Description'),
      h('textarea', {
        rows: '3',
        value: wizard.prompt.description,
        placeholder: 'Describe what the model should do, for whom, and what quality looks like.',
        onInput: (e: Event) => { wizard.prompt.description = (e.target as HTMLTextAreaElement).value; },
      })
    ),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Variables (comma-separated)'),
        h('input', {
          type: 'text',
          value: wizard.prompt.variablesCsv,
          placeholder: 'region, year, metric',
          onInput: (e: Event) => { wizard.prompt.variablesCsv = (e.target as HTMLInputElement).value; },
        })
      ),
      h('div', null,
        h('label', null, 'Tags (comma-separated)'),
        h('input', {
          type: 'text',
          value: wizard.prompt.tagsCsv,
          placeholder: 'economy, nz, regional',
          onInput: (e: Event) => { wizard.prompt.tagsCsv = (e.target as HTMLInputElement).value; },
        })
      )
    )
  );

  const sectionTemplate = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '2) Prompt Template + Fragment Insertion'),
    h('div', { className: 'prompt-wizard-inline' },
      h('select', {
        'data-testid': 'prompt-fragment-select',
        value: wizard.fragments.selectedKey,
        onChange: (e: Event) => { wizard.fragments.selectedKey = (e.target as HTMLSelectElement).value; },
      },
        h('option', { value: '' }, 'Select an existing fragment...'),
        ...fragmentRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
      ),
      h('button', {
        className: 'row-btn row-btn-edit',
        'data-testid': 'insert-fragment-marker',
        onClick: () => insertFragmentMarkerIntoTemplate(wizard, String(wizard.fragments.selectedKey || ''), render),
      }, 'Insert Marker')
    ),
    h('textarea', {
      'data-testid': 'prompt-template-editor',
      'data-prompt-template-editor': 'true',
      rows: '12',
      value: wizard.prompt.template,
      placeholder: 'Write your prompt template here. Use {{variable}} and insert fragments like {{>fragment_key}}.',
      onInput: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.template = target.value;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
      onClick: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
      onSelect: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
      onKeyUp: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
    }),
    h('div', { className: 'prompt-wizard-hint' }, 'Tip: choose a fragment above and click Insert Marker. Marker inserts at your cursor position.'),
    h('div', { className: 'prompt-token-row' },
      h('strong', null, 'Detected variables:'),
      ...(tokenSummary.variables.length
        ? tokenSummary.variables.map((name) => h('span', { className: 'prompt-token prompt-token-variable' }, `{{${name}}}`))
        : [h('span', { className: 'prompt-token prompt-token-empty' }, 'none')])
    ),
    h('div', { className: 'prompt-token-row' },
      h('strong', null, 'Detected fragments:'),
      ...(tokenSummary.fragments.length
        ? tokenSummary.fragments.map((name) => h('span', { className: `prompt-token prompt-token-fragment ${fragmentRows.some((row: any) => row.key === name) ? 'ok' : 'warn'}` }, `{{>${name}}}`))
        : [h('span', { className: 'prompt-token prompt-token-empty' }, 'none')])
    ),
    renderPromptTemplatePreview(wizard, fragmentRows)
  );

  const sectionFramework = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '3) Framework (optional)'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Use Existing Framework'),
        h('select', {
          value: wizard.framework.selectedKey,
          onChange: (e: Event) => { wizard.framework.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...frameworkRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        )
      ),
      h('div', null,
        h('label', null, 'Create New Framework'),
        h('input', {
          type: 'checkbox',
          checked: !!wizard.framework.createNew,
          onChange: (e: Event) => { wizard.framework.createNew = (e.target as HTMLInputElement).checked; render(); },
        })
      )
    )
  );

  if (wizard.framework.createNew) {
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Framework Name'),
          h('input', { type: 'text', value: wizard.framework.name, onInput: (e: Event) => { wizard.framework.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Framework Key'),
          h('input', { type: 'text', value: wizard.framework.key, onInput: (e: Event) => { wizard.framework.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionFramework.appendChild(
      h('div', null,
        h('label', null, 'Framework Description'),
        h('textarea', { rows: '2', value: wizard.framework.description, onInput: (e: Event) => { wizard.framework.description = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-inline', style: 'margin-top:8px;' },
        h('select', {
          value: wizard.framework.newSectionKey,
          onChange: (e: Event) => { wizard.framework.newSectionKey = (e.target as HTMLSelectElement).value; },
        },
          ...['role', 'task', 'context', 'expectations', 'constraints', 'examples', 'output_contract', 'review_instructions', 'custom']
            .map((key) => h('option', { value: key }, key))
        ),
        h('button', {
          className: 'row-btn',
          onClick: () => {
            const key = String(wizard.framework.newSectionKey || 'custom');
            wizard.framework.sections = [
              ...(wizard.framework.sections || []),
              {
                key,
                label: key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
                required: false,
                header: `## ${key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}\\n`,
              },
            ];
            render();
          },
        }, 'Add Section')
      )
    );
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-list' },
        ...(wizard.framework.sections || []).map((section: any, index: number) =>
          h('div', { className: 'prompt-wizard-list-item prompt-section-item' },
            h('div', { className: 'prompt-section-main' },
              h('div', { className: 'prompt-wizard-grid' },
                h('div', null,
                  h('label', null, 'Section Key'),
                  h('input', {
                    type: 'text',
                    value: String(section.key || ''),
                    onInput: (e: Event) => { section.key = (e.target as HTMLInputElement).value; },
                  })
                ),
                h('div', null,
                  h('label', null, 'Label'),
                  h('input', {
                    type: 'text',
                    value: String(section.label || ''),
                    onInput: (e: Event) => { section.label = (e.target as HTMLInputElement).value; },
                  })
                )
              ),
              h('div', null,
                h('label', null, 'Header (leave blank for auto-header; use null to suppress)'),
                h('input', {
                  type: 'text',
                  value: section.header === null ? 'null' : String(section.header || ''),
                  onInput: (e: Event) => {
                    const value = (e.target as HTMLInputElement).value;
                    section.header = value.trim().toLowerCase() === 'null' ? null : value;
                  },
                })
              ),
              h('label', { className: 'prompt-wizard-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: !!section.required,
                  onChange: (e: Event) => { section.required = (e.target as HTMLInputElement).checked; },
                }),
                h('span', null, 'Required')
              )
            ),
            h('div', { className: 'prompt-section-actions' },
              h('button', { className: 'row-btn', onClick: () => { moveWizardFrameworkSection(wizard, index, -1); render(); } }, 'Up'),
              h('button', { className: 'row-btn', onClick: () => { moveWizardFrameworkSection(wizard, index, 1); render(); } }, 'Down'),
              h('button', {
                className: 'row-btn row-btn-del',
                onClick: () => {
                  wizard.framework.sections = wizard.framework.sections.filter((_: any, i: number) => i !== index);
                  render();
                },
              }, 'Remove')
            )
          )
        )
      )
    );
  }

  const sectionStrategyContract = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '4) Strategy + Output Contract (optional)'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Use Existing Strategy'),
        h('select', {
          value: wizard.strategy.selectedKey,
          onChange: (e: Event) => { wizard.strategy.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...strategyRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        ),
        h('label', { className: 'prompt-wizard-toggle' },
          h('input', {
            type: 'checkbox',
            checked: !!wizard.strategy.createNew,
            onChange: (e: Event) => { wizard.strategy.createNew = (e.target as HTMLInputElement).checked; render(); },
          }),
          h('span', null, 'Create new strategy in this flow')
        )
      ),
      h('div', null,
        h('label', null, 'Use Existing Output Contract'),
        h('select', {
          value: wizard.contract.selectedKey,
          onChange: (e: Event) => { wizard.contract.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...contractRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        ),
        h('label', { className: 'prompt-wizard-toggle' },
          h('input', {
            type: 'checkbox',
            checked: !!wizard.contract.createNew,
            onChange: (e: Event) => { wizard.contract.createNew = (e.target as HTMLInputElement).checked; render(); },
          }),
          h('span', null, 'Create new output contract in this flow')
        )
      )
    )
  );

  if (wizard.strategy.createNew) {
    sectionStrategyContract.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Strategy Name'),
          h('input', { type: 'text', value: wizard.strategy.name, onInput: (e: Event) => { wizard.strategy.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Strategy Key'),
          h('input', { type: 'text', value: wizard.strategy.key, onInput: (e: Event) => { wizard.strategy.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Instruction Prefix'),
        h('textarea', { rows: '2', value: wizard.strategy.instructionPrefix, onInput: (e: Event) => { wizard.strategy.instructionPrefix = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Instruction Suffix'),
        h('textarea', { rows: '2', value: wizard.strategy.instructionSuffix, onInput: (e: Event) => { wizard.strategy.instructionSuffix = (e.target as HTMLTextAreaElement).value; } })
      )
    );
  }

  if (wizard.contract.createNew) {
    sectionStrategyContract.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Contract Name'),
          h('input', { type: 'text', value: wizard.contract.name, onInput: (e: Event) => { wizard.contract.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Contract Key'),
          h('input', { type: 'text', value: wizard.contract.key, onInput: (e: Event) => { wizard.contract.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Contract Type'),
        h('select', {
          value: wizard.contract.contractType,
          onChange: (e: Event) => { wizard.contract.contractType = (e.target as HTMLSelectElement).value; },
        },
          ...['json', 'markdown', 'code', 'max_length', 'forbidden_content', 'structured'].map((type) => h('option', { value: type }, type))
        )
      )
    );
  }

  const sectionFragments = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '5) Optional: Create New Fragments in this Flow'),
    h('label', { className: 'prompt-wizard-toggle' },
      h('input', {
        type: 'checkbox',
        checked: !!wizard.fragments.createNew,
        onChange: (e: Event) => { wizard.fragments.createNew = (e.target as HTMLInputElement).checked; render(); },
      }),
      h('span', null, 'Create new fragments now')
    )
  );

  if (wizard.fragments.createNew) {
    sectionFragments.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Fragment Name'),
          h('input', { type: 'text', value: wizard.fragments.name, onInput: (e: Event) => { wizard.fragments.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Fragment Key'),
          h('input', { type: 'text', value: wizard.fragments.key, onInput: (e: Event) => { wizard.fragments.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionFragments.appendChild(
      h('div', null,
        h('label', null, 'Fragment Content'),
        h('textarea', { rows: '3', value: wizard.fragments.content, onInput: (e: Event) => { wizard.fragments.content = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionFragments.appendChild(
      h('div', { className: 'prompt-wizard-inline' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => queuePromptWizardFragment(render) }, 'Add Fragment to Queue'),
        h('button', {
          className: 'row-btn',
          onClick: () => {
            const key = slugifyPromptKey(wizard.fragments.key || wizard.fragments.name);
            if (key) insertFragmentMarkerIntoTemplate(wizard, key, render);
          },
        }, 'Insert Marker in Template')
      )
    );
    if ((wizard.fragments.queued || []).length) {
      sectionFragments.appendChild(
        h('div', { className: 'prompt-wizard-list' },
          ...wizard.fragments.queued.map((fragment: any, index: number) =>
            h('div', { className: 'prompt-wizard-list-item' },
              h('span', null, `${fragment.key} - ${fragment.name}`),
              h('button', {
                className: 'row-btn row-btn-del',
                onClick: () => {
                  wizard.fragments.queued = wizard.fragments.queued.filter((_: any, i: number) => i !== index);
                  render();
                },
              }, 'Remove')
            )
          )
        )
      );
    }
  }

  box.appendChild(sectionBasics);
  box.appendChild(sectionTemplate);
  box.appendChild(sectionFramework);
  box.appendChild(sectionStrategyContract);
  box.appendChild(sectionFragments);

  if (wizard.error) box.appendChild(h('div', { className: 'prompt-wizard-error' }, wizard.error));
  if (wizard.status) box.appendChild(h('div', { className: 'prompt-wizard-status' }, wizard.status));

  box.appendChild(
    h('div', { className: 'prompt-wizard-actions' },
      h('button', {
        className: 'nav-btn active',
        disabled: !!wizard.saving,
        onClick: () => { void savePromptWizardPackage(render); },
      }, wizard.saving ? 'Saving...' : wizard.mode === 'edit' ? 'Update Prompt Package' : 'Create Prompt Package'),
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          resetPromptWizard(state, 'create');
          render();
        },
      }, 'Reset Wizard')
    )
  );

  return box;
}