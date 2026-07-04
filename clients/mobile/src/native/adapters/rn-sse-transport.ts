/**
 * rn-sse-transport.ts — a React-Native-compatible {@link GeneweaveTransport}.
 *
 * Device-gated. React Native's `fetch` does **not** expose `response.body` as a
 * `ReadableStream`, so the default fetch-streaming transport's `openStream`
 * fails with `stream open failed → 200` (the 200 is fine; `resp.body` is null).
 * This adapter keeps the default transport for the non-streaming `request`
 * path and replaces `openStream` with an incremental `XMLHttpRequest` reader —
 * the same mechanism `react-native-sse` uses — so resumable SSE works on-device
 * with no native dependency.
 *
 * The SSE line framing mirrors the default transport exactly: `data:` lines are
 * accumulated and flushed on a blank line; `:`-comment keepalives are ignored;
 * malformed JSON is skipped without tearing down the stream. Resume semantics
 * (`?after=`), reconnects, and dedupe all live in the client's `attachRun`
 * loop and are unchanged — this only swaps the byte transport.
 */
import {
  createHttpTransport,
  type CreateHttpTransportOptions,
  type GeneweaveTransport,
  type StreamHandlers,
} from '@weaveintel/api-client';
import { createSseFrameParser } from '../../lib';

function joinUrl(host: string, path: string): string {
  return host.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

export function createRnSseTransport(opts: CreateHttpTransportOptions): GeneweaveTransport {
  const base = createHttpTransport(opts);

  return {
    request: (req) => base.request(req),

    openStream(input: { path: string; signal?: AbortSignal }, handlers: StreamHandlers): void {
      // eslint-disable-next-line no-undef
      const xhr = new XMLHttpRequest();
      let aborted = false;
      let opened = false;
      let cursor = 0; // bytes of responseText already consumed
      const parser = createSseFrameParser({ onEvent: handlers.onEvent });

      const onAbort = () => {
        aborted = true;
        try {
          xhr.abort();
        } catch {
          /* already closed */
        }
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      xhr.onreadystatechange = () => {
        if (aborted) return;

        // Validate the response status once, as soon as headers arrive.
        if (!opened && xhr.readyState >= 2 && xhr.status !== 0) {
          opened = true;
          if (xhr.status < 200 || xhr.status >= 300) {
            handlers.onError?.(new Error(`stream open failed → ${xhr.status}`));
            try {
              xhr.abort();
            } catch {
              /* already closed */
            }
            handlers.onClose?.();
            return;
          }
        }

        // Drain any newly-arrived text (readyState 3 LOADING, 4 DONE).
        if (xhr.readyState >= 3) {
          const full = xhr.responseText ?? '';
          if (full.length > cursor) {
            const chunk = full.slice(cursor);
            cursor = full.length;
            parser.push(chunk);
          }
        }

        if (xhr.readyState === 4) {
          parser.end();
          handlers.onClose?.();
        }
      };

      xhr.onerror = () => {
        if (!aborted) handlers.onError?.(new Error('stream network error'));
        handlers.onClose?.();
      };

      void (async () => {
        let token: string | undefined;
        try {
          const tokens = await opts.tokenStore.get();
          token = tokens?.token;
        } catch {
          token = undefined;
        }
        if (aborted) return;
        try {
          xhr.open('GET', joinUrl(opts.host, input.path), true);
          xhr.setRequestHeader('Accept', 'text/event-stream');
          xhr.setRequestHeader('Cache-Control', 'no-cache');
          for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
            xhr.setRequestHeader(k, v);
          }
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.send();
        } catch (err) {
          handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
          handlers.onClose?.();
        }
      })();
    },
  };
}
