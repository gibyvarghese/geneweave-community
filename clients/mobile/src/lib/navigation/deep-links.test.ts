import { describe, it, expect } from 'vitest';
import { parseDeepLink, buildDeepLink, intentToRoute, DEEP_LINK_SCHEME } from './deep-links.js';

describe('parseDeepLink', () => {
  it('parses the three launch link kinds from scheme:// form', () => {
    expect(parseDeepLink('geneweave://run/abc123')).toEqual({ kind: 'run', runId: 'abc123' });
    expect(parseDeepLink('geneweave://task/t-1')).toEqual({ kind: 'task', taskId: 't-1' });
    expect(parseDeepLink('geneweave://reminder/r-9')).toEqual({ kind: 'reminder', reminderId: 'r-9' });
  });

  it('tolerates triple-slash and bare scheme: forms', () => {
    expect(parseDeepLink('geneweave:///run/abc')).toEqual({ kind: 'run', runId: 'abc' });
    expect(parseDeepLink('geneweave:run/abc')).toEqual({ kind: 'run', runId: 'abc' });
  });

  it('strips query and fragment', () => {
    expect(parseDeepLink('geneweave://run/abc?foo=1#frag')).toEqual({ kind: 'run', runId: 'abc' });
  });

  it('decodes percent-encoded ids', () => {
    expect(parseDeepLink('geneweave://task/a%20b')).toEqual({ kind: 'task', taskId: 'a b' });
  });

  it('returns unknown for unrecognized or malformed links', () => {
    expect(parseDeepLink('geneweave://settings/x')).toEqual({ kind: 'unknown', raw: 'geneweave://settings/x' });
    expect(parseDeepLink('geneweave://run')).toEqual({ kind: 'unknown', raw: 'geneweave://run' });
    expect(parseDeepLink('')).toEqual({ kind: 'unknown', raw: '' });
  });
});

describe('buildDeepLink', () => {
  it('round-trips with parseDeepLink', () => {
    const link = buildDeepLink({ kind: 'run', runId: 'abc 123' });
    expect(link.startsWith(`${DEEP_LINK_SCHEME}://run/`)).toBe(true);
    expect(parseDeepLink(link)).toEqual({ kind: 'run', runId: 'abc 123' });
  });
});

describe('intentToRoute', () => {
  it('maps run to the Chat tab with runId', () => {
    expect(intentToRoute({ kind: 'run', runId: 'r1' })).toEqual({ pathname: '/(tabs)', params: { runId: 'r1' } });
  });
  it('maps task and reminder to the Actions tab', () => {
    expect(intentToRoute({ kind: 'task', taskId: 't1' }).pathname).toBe('/(tabs)/actions');
    expect(intentToRoute({ kind: 'reminder', reminderId: 'm1' }).pathname).toBe('/(tabs)/actions');
  });
  it('falls back to the Chat tab for unknown intents', () => {
    expect(intentToRoute({ kind: 'unknown', raw: 'x' })).toEqual({ pathname: '/(tabs)', params: {} });
  });
});
