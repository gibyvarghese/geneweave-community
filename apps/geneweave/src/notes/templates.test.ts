// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  SYSTEM_TEMPLATES, TEMPLATE_NODE_TYPES, templateByKey, templateCategories, listSystemTemplates,
  type NoteTemplate,
} from './templates.js';
import type { PMNode } from '@weaveintel/notes';

/** Walk every node in a template doc (depth-first). */
function walk(node: PMNode, visit: (n: PMNode) => void): void {
  visit(node);
  for (const c of node.content ?? []) walk(c, visit);
}

describe('templates — the system template set', () => {
  it('ships the expected templates with unique keys + all categories used', () => {
    expect(SYSTEM_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    const keys = SYSTEM_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length); // unique
    for (const must of ['blank', 'cornell', 'meeting-minutes', 'study-sheet', 'active-recall', 'zettelkasten',
      'solution-architecture', 'design-doc', 'customer-journey', 'prd']) {
      expect(keys).toContain(must);
    }
    // The categories appear in the gallery's reading order; only categories that have templates are returned.
    expect(templateCategories()).toEqual(['Blank', 'Engineering', 'Product', 'Design', 'Planning', 'Meetings', 'Knowledge', 'Thinking', 'Study', 'Personal']);
  });

  it('every template has a title, icon, description + a valid doc', () => {
    for (const tpl of SYSTEM_TEMPLATES) {
      expect(tpl.title.length).toBeGreaterThan(0);
      expect(tpl.icon.length).toBeGreaterThan(0);
      expect(tpl.description.length).toBeGreaterThan(0);
      expect(tpl.doc.type).toBe('doc');
      expect(Array.isArray(tpl.doc.content)).toBe(true);
      expect(tpl.doc.content.length).toBeGreaterThan(0);
    }
  });

  it('every node in every template is an editor-RENDERABLE type (no unsupported nodes)', () => {
    for (const tpl of SYSTEM_TEMPLATES) {
      walk(tpl.doc as unknown as PMNode, (n) => {
        expect(TEMPLATE_NODE_TYPES.has(n.type), `${tpl.key}: node "${n.type}"`).toBe(true);
      });
    }
  });

  it('the meeting-minutes template has an ACTION-ITEMS task list (feeds tasks via extract)', () => {
    const mm = templateByKey('meeting-minutes')!;
    let hasTaskItem = false;
    walk(mm.doc as unknown as PMNode, (n) => { if (n.type === 'taskItem') hasTaskItem = true; });
    expect(hasTaskItem).toBe(true);
    // and the headline sections are present
    const headings: string[] = [];
    walk(mm.doc as unknown as PMNode, (n) => { if (n.type === 'heading') headings.push((n.content?.[0]?.text ?? '').toLowerCase()); });
    expect(headings).toEqual(expect.arrayContaining(['attendees', 'agenda', 'action items', 'next meeting']));
  });

  it('each task/list/callout node is well-formed (renders cleanly)', () => {
    for (const tpl of SYSTEM_TEMPLATES) {
      walk(tpl.doc as unknown as PMNode, (n) => {
        if (n.type === 'callout') expect(['note', 'tip', 'warning', 'success', 'danger']).toContain(n.attrs?.['tone']);
        if (n.type === 'taskItem') expect(typeof n.attrs?.['checked']).toBe('boolean');
        if (n.type === 'heading') expect(Number(n.attrs?.['level'])).toBeGreaterThanOrEqual(1);
      });
    }
  });
});

describe('templates — helpers', () => {
  it('templateByKey resolves + returns undefined for unknown', () => {
    expect(templateByKey('cornell')?.title).toBe('Cornell notes');
    expect(templateByKey('nope')).toBeUndefined();
  });
  it('listSystemTemplates filters by category', () => {
    const study = listSystemTemplates('Study');
    expect(study.length).toBeGreaterThanOrEqual(2);
    expect(study.every((t: NoteTemplate) => t.category === 'Study')).toBe(true);
    expect(listSystemTemplates().length).toBe(SYSTEM_TEMPLATES.length);
  });
  it('the docs are JSON-serialisable (safe to persist as doc_json)', () => {
    for (const tpl of SYSTEM_TEMPLATES) {
      const round = JSON.parse(JSON.stringify(tpl.doc));
      expect(round.type).toBe('doc');
    }
  });
});
