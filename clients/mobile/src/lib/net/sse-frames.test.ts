import { describe, it, expect } from 'vitest';
import { createSseFrameParser } from './sse-frames.js';

function collect(): { events: unknown[]; errors: string[]; onEvent: (v: unknown) => void; onError: (e: Error, raw: string) => void } {
  const events: unknown[] = [];
  const errors: string[] = [];
  return {
    events,
    errors,
    onEvent: (v) => events.push(v),
    onError: (_e, raw) => errors.push(raw),
  };
}

describe('createSseFrameParser', () => {
  it('emits one event per complete data frame', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: {"a":1}\n\n');
    expect(c.events).toEqual([{ a: 1 }]);
  });

  it('buffers across chunk boundaries that split a frame mid-line', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: {"hel');
    p.push('lo":"world"}');
    expect(c.events).toEqual([]); // not flushed yet
    p.push('\n\n');
    expect(c.events).toEqual([{ hello: 'world' }]);
  });

  it('joins multiple data: lines in one frame with a newline', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: "line1\\n');
    // two physical data lines forming one JSON string value
    p.push('"\n\n');
    expect(c.events).toEqual(['line1\n']);
  });

  it('ignores :comment keepalive lines without emitting', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push(': keepalive\n\n');
    p.push('data: {"ok":true}\n\n');
    expect(c.events).toEqual([{ ok: true }]);
    expect(c.errors).toEqual([]);
  });

  it('strips trailing CR on CRLF transports', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: {"x":2}\r\n\r\n');
    expect(c.events).toEqual([{ x: 2 }]);
  });

  it('reports malformed JSON via onError and keeps the stream alive', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: not-json\n\n');
    p.push('data: {"after":1}\n\n');
    expect(c.errors).toEqual(['not-json']);
    expect(c.events).toEqual([{ after: 1 }]);
  });

  it('flushes a trailing frame without a final blank line on end()', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('data: {"tail":9}');
    expect(c.events).toEqual([]); // no blank line yet
    p.end();
    expect(c.events).toEqual([{ tail: 9 }]);
  });

  it('ignores event:/id: fields for this surface', () => {
    const c = collect();
    const p = createSseFrameParser(c);
    p.push('event: ping\nid: 42\ndata: {"v":1}\n\n');
    expect(c.events).toEqual([{ v: 1 }]);
  });
});
