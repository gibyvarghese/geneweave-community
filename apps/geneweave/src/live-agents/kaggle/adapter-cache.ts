/**
 * Per-tick read cache for the Kaggle adapter.
 *
 * Why: the strategist's ReAct loop reliably calls the same read-only
 * tool (e.g. `kaggle_list_competition_files`, `kaggle_list_competitions`,
 * `kaggle_get_competition`) 20+ times per tick with identical args while
 * thrashing on a hard problem. Each call burns adapter latency, audit
 * rows, and tokens echoing the same body back into the model context.
 *
 * This wrapper memoises the documented read-only methods of `KaggleAdapter`
 * for the lifetime of one tick. WRITE methods (push, submit, etc.) are
 * passed through untouched. Errors are NOT cached — a transient 500 on
 * one call still allows a retry to succeed.
 *
 * Use it once per handler invocation; do NOT share across ticks.
 */

import type { KaggleAdapter } from '../../kaggle/index.js';

/** Read-only methods we memoise. Write methods (push/submit) bypass. */
const CACHED_METHODS = new Set([
  'listCompetitions',
  'getCompetition',
  'listCompetitionFiles',
  'downloadCompetitionFile',
  'getLeaderboard',
  'listSubmissions',
  'listDatasets',
  'getDataset',
  'listDatasetFiles',
  'listKernels',
  'getKernelStatus',
  'getKernelOutput',
  'pullKernel',
]);

/**
 * Wrap a `KaggleAdapter` so successive identical reads within a single
 * agent tick return the cached promise. Returns a new object — the
 * underlying adapter is never mutated.
 */
export function withPerTickReadCache(adapter: KaggleAdapter): KaggleAdapter {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      if (!CACHED_METHODS.has(name)) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        // Skip the credentials object (always first arg) when keying — it
        // doesn't change between calls within one tick and stringifying it
        // would needlessly expose the API key in cache keys / logs.
        const keyArgs = args.slice(1);
        let key: string;
        try {
          key = `${name}:${JSON.stringify(keyArgs)}`;
        } catch {
          // Non-serialisable arg → don't cache.
          return value.apply(target, args);
        }
        const hit = cache.get(key);
        if (hit) return hit;
        const p = (async () => {
          try {
            return await value.apply(target, args);
          } catch (err) {
            // Evict so a retry can re-attempt.
            cache.delete(key);
            throw err;
          }
        })();
        cache.set(key, p);
        return p;
      };
    },
  });
}
