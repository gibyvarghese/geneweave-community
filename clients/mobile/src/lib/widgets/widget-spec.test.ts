/**
 * widget-spec.test.ts — Node unit + snapshot tests for the pure widget brain.
 *
 * Snapshots are taken on the resolved {@link WidgetViewSpec} per kind (the
 * native renderers are dumb maps over these), plus explicit assertions for the
 * two fallback contracts (unknown type, unsupported schemaVersion), a11y-label
 * derivation, and graceful coercion of malformed / partial data.
 */
import { describe, it, expect } from 'vitest';
import { buildWidgetSpec, type WidgetViewSpec } from './widget-spec.js';
import { widgetFixtures } from './widget-fixtures.js';

describe('buildWidgetSpec — fixtures (snapshot per kind)', () => {
  for (const fixture of widgetFixtures) {
    it(`resolves "${fixture.caption}"`, () => {
      expect(buildWidgetSpec(fixture.view)).toMatchSnapshot();
    });
  }
});

describe('buildWidgetSpec — render-kind routing', () => {
  const kindOf = (caption: string): WidgetViewSpec['kind'] => {
    const f = widgetFixtures.find((x) => x.caption === caption)!;
    return buildWidgetSpec(f.view).kind;
  };

  it('maps each known type to its render kind', () => {
    expect(kindOf('table')).toBe('table');
    expect(kindOf('chart')).toBe('chart');
    expect(kindOf('code')).toBe('code');
    expect(kindOf('image')).toBe('image');
    expect(kindOf('map')).toBe('map');
    expect(kindOf('timeline')).toBe('timeline');
    expect(kindOf('form')).toBe('form');
    expect(kindOf('approval')).toBe('approval');
    expect(kindOf('citation')).toBe('citation');
    expect(kindOf('artifact')).toBe('artifact');
    expect(kindOf('progress')).toBe('progress');
  });

  it('degrades an unknown widget type to fallback with the link href', () => {
    const spec = buildWidgetSpec(widgetFixtures.find((f) => f.caption === 'fallback — unknown type')!.view);
    expect(spec.kind).toBe('fallback');
    if (spec.kind !== 'fallback') throw new Error('expected fallback');
    expect(spec.href).toBe('https://example.com/viewer');
    expect(spec.text).toContain('open on desktop');
  });

  it('degrades an unsupported schemaVersion to fallback even for a known type', () => {
    const spec = buildWidgetSpec(widgetFixtures.find((f) => f.caption === 'fallback — unsupported schemaVersion')!.view);
    expect(spec.kind).toBe('fallback');
  });

  it('degrades the open-ended custom type to fallback', () => {
    const spec = buildWidgetSpec({ id: 'c', payload: { id: 'c', type: 'custom', title: 'Anything' } });
    expect(spec.kind).toBe('fallback');
  });
});

describe('buildWidgetSpec — a11y label derivation', () => {
  it('prefers a11ySummary', () => {
    const spec = buildWidgetSpec({ id: 'x', payload: { type: 'code', a11ySummary: 'Summary wins', title: 'T', data: { code: 'x' } } });
    expect(spec.a11yLabel).toBe('Summary wins');
  });

  it('falls back to title when no a11ySummary', () => {
    const spec = buildWidgetSpec({ id: 'x', payload: { type: 'code', title: 'A code block', data: { code: 'x' } } });
    expect(spec.a11yLabel).toBe('A code block');
  });

  it('humanises the type when neither a11ySummary nor title is present', () => {
    const spec = buildWidgetSpec({ id: 'x', payload: { type: 'code', data: { code: 'x' } } });
    expect(spec.a11yLabel).toBe('Code');
  });
});

describe('buildWidgetSpec — graceful coercion', () => {
  it('never throws on a completely empty payload', () => {
    expect(() => buildWidgetSpec({ id: 'e', payload: {} })).not.toThrow();
    expect(buildWidgetSpec({ id: 'e', payload: {} }).kind).toBe('fallback');
  });

  it('degrades a table with no columns or rows to fallback', () => {
    const spec = buildWidgetSpec({ id: 't', payload: { type: 'table', title: 'Empty', data: {} } });
    expect(spec.kind).toBe('fallback');
  });

  it('coerces object rows keyed by column key into ordered cells', () => {
    const spec = buildWidgetSpec({
      id: 't',
      payload: {
        type: 'table',
        data: { columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: 1, b: 2 }] },
      },
    });
    if (spec.kind !== 'table') throw new Error('expected table');
    expect(spec.columns).toEqual(['A', 'B']);
    expect(spec.rows).toEqual([['1', '2']]);
  });

  it('clamps progress percentage from current/total', () => {
    const spec = buildWidgetSpec({ id: 'p', payload: { type: 'progress', data: { current: 3, total: 4 } } });
    if (spec.kind !== 'progress') throw new Error('expected progress');
    expect(spec.percentage).toBe(75);
  });

  it('supplies default approve/deny actions when none are given', () => {
    const spec = buildWidgetSpec({ id: 'a', payload: { type: 'approval', title: 'Proceed?', data: { description: 'do it' } } });
    if (spec.kind !== 'approval') throw new Error('expected approval');
    expect(spec.actions.map((a) => a.actionId)).toEqual(['approve', 'deny']);
  });

  it('reads approval fields from the payload root when data is empty', () => {
    const spec = buildWidgetSpec({
      id: 'a',
      payload: { type: 'approval', description: 'root-level desc', actions: [{ label: 'OK', value: 'ok' }] },
    });
    if (spec.kind !== 'approval') throw new Error('expected approval');
    expect(spec.description).toBe('root-level desc');
    expect(spec.actions[0]?.actionId).toBe('ok');
  });
});
