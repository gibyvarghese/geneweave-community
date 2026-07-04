/**
 * sse-frames.ts — a pure, incremental Server-Sent-Events frame parser.
 *
 * This is the framing brain shared by the React-Native XHR stream transport
 * (`src/native/adapters/rn-sse-transport.ts`). It is deliberately free of any
 * transport: you feed it text chunks as they arrive (from `xhr.responseText`
 * slices, a `fetch` reader, or a test) and it emits one parsed value per
 * complete SSE event.
 *
 * Framing rules (mirroring the api-client's default fetch transport):
 *   - `data:` lines are accumulated; a blank line flushes them as one event.
 *   - multiple `data:` lines in one event are joined with `\n`.
 *   - `:`-prefixed comment lines (keepalives) are ignored.
 *   - `event:` / `id:` / `retry:` fields are ignored for this surface.
 *   - trailing `\r` (CRLF transports) is stripped per line.
 *   - malformed JSON is dropped via the `onError` hook without tearing down the
 *     parser, so one bad frame never kills the stream.
 */

/** A stateful, incremental SSE parser. Not safe to share across streams. */
export interface SseFrameParser {
  /** Feed a chunk of newly-arrived text. Emits each complete event. */
  push(chunk: string): void;
  /** Flush any buffered complete event at end-of-stream. */
  end(): void;
}

export interface SseFrameParserOptions {
  /** Called once per complete event with the parsed JSON value. */
  onEvent: (value: unknown) => void;
  /** Called when a frame's data is not valid JSON. Optional. */
  onError?: (err: Error, rawData: string) => void;
}

/**
 * Create an incremental SSE frame parser.
 *
 * @example
 * const p = createSseFrameParser({ onEvent: (v) => events.push(v) });
 * p.push('data: {"a":1}\n');
 * p.push('\n'); // flush → emits { a: 1 }
 */
export function createSseFrameParser(opts: SseFrameParserOptions): SseFrameParser {
  let buf = ''; // leftover partial line between chunks
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '' || data.startsWith(':')) return; // comment / keepalive
    try {
      opts.onEvent(JSON.parse(data));
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)), data);
    }
  };

  const consumeLine = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (line === '') flush();
    // `event:` / `id:` / `retry:` / `:comment` lines are ignored.
  };

  return {
    push(chunk: string): void {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    },
    end(): void {
      if (buf.length > 0) {
        consumeLine(buf);
        buf = '';
      }
      flush();
    },
  };
}
