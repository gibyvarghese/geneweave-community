import { h } from './dom.js';
import { ensureWizardFrameworkSections } from './prompt-wizard-utils.js';

export function moveWizardFrameworkSection(wizard: any, index: number, dir: -1 | 1): void {
  ensureWizardFrameworkSections(wizard);
  const next = index + dir;
  if (next < 0 || next >= wizard.framework.sections.length) return;
  const copy = [...wizard.framework.sections];
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item);
  wizard.framework.sections = copy;
}

export function insertFragmentMarkerIntoTemplate(
  wizard: any,
  fragmentKey: string,
  rerender: () => void,
): void {
  if (!fragmentKey) return;
  const marker = `{{>${fragmentKey}}}`;
  const current = String(wizard.prompt.template || '');
  const editor = document.querySelector('textarea[data-prompt-template-editor="true"]') as HTMLTextAreaElement | null;
  const fallbackStart = Number.isFinite(wizard.prompt.cursorStart) ? wizard.prompt.cursorStart : current.length;
  const fallbackEnd = Number.isFinite(wizard.prompt.cursorEnd) ? wizard.prompt.cursorEnd : fallbackStart;
  const start = editor ? editor.selectionStart : fallbackStart;
  const end = editor ? editor.selectionEnd : fallbackEnd;
  const from = Math.max(0, Math.min(start, current.length));
  const to = Math.max(from, Math.min(end, current.length));
  wizard.prompt.template = `${current.slice(0, from)}${marker}${current.slice(to)}`;
  const nextCursor = from + marker.length;
  wizard.prompt.cursorStart = nextCursor;
  wizard.prompt.cursorEnd = nextCursor;
  wizard.status = `Inserted fragment marker ${marker} into template.`;
  wizard.error = '';
  rerender();
  requestAnimationFrame(() => {
    const nextEditor = document.querySelector('textarea[data-prompt-template-editor="true"]') as HTMLTextAreaElement | null;
    if (!nextEditor) return;
    nextEditor.focus();
    nextEditor.setSelectionRange(nextCursor, nextCursor);
  });
}

export function renderPromptTemplatePreview(wizard: any, fragmentRows: any[]): HTMLElement {
  const template = String(wizard.prompt.template || '');
  const fragmentKeys = new Set(fragmentRows.map((row: any) => String(row.key || '')));
  const preview = h('pre', { className: 'prompt-template-preview' });

  if (!template.trim()) {
    preview.appendChild(h('span', { className: 'prompt-template-empty' }, 'Template preview will appear here as you type.'));
    return preview;
  }

  const tokenRegex = /\{\{>\s*([a-zA-Z0-9._-]+)\s*\}\}|\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(template)) !== null) {
    const idx = match.index;
    if (idx > last) preview.appendChild(document.createTextNode(template.slice(last, idx)));
    const fragmentKey = match[1];
    const variableKey = match[2];
    if (fragmentKey) {
      const tone = fragmentKeys.has(fragmentKey) ? 'ok' : 'warn';
      preview.appendChild(h('span', { className: `prompt-token prompt-token-fragment ${tone}` }, `{{>${fragmentKey}}}`));
    } else if (variableKey) {
      preview.appendChild(h('span', { className: 'prompt-token prompt-token-variable' }, `{{${variableKey}}}`));
    }
    last = idx + match[0].length;
  }
  if (last < template.length) preview.appendChild(document.createTextNode(template.slice(last)));
  return preview;
}