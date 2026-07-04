export function normalizeAdminPath(path: string): string {
  let p = String(path || '').replace(/^\/+/, '');
  if (p.startsWith('api/')) p = p.slice(4);
  return '/' + p;
}

export function slugifyPromptKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function parseWizardObject(input: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  if (typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

export function stripPossibleJsonQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function defaultWizardFrameworkSections() {
  return [
    { key: 'role', label: 'Role', required: true, header: null },
    { key: 'task', label: 'Task', required: true, header: '## Task\n' },
    { key: 'context', label: 'Context', required: false, header: '## Context\n' },
    { key: 'expectations', label: 'Expectations', required: false, header: '## Expectations\n' },
  ];
}

export function ensureWizardFrameworkSections(wizard: any) {
  if (!Array.isArray(wizard.framework.sections) || !wizard.framework.sections.length) {
    wizard.framework.sections = defaultWizardFrameworkSections();
  }
}

export function buildFrameworkSectionsFromWizard(wizard: any) {
  ensureWizardFrameworkSections(wizard);
  return wizard.framework.sections.map((section: any, index: number) => ({
    key: String(section.key || `section_${index + 1}`),
    label: String(section.label || section.key || `Section ${index + 1}`),
    renderOrder: (index + 1) * 10,
    required: !!section.required,
    header: section.header === null ? null : String(section.header || `## ${section.label || section.key || `Section ${index + 1}`}\n`),
  }));
}